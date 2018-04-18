const net = require("net");
const events = require('events');
const fs = require('fs');
const express = require('express');
const app = require('express')();
const http = require('http');
const path = require('path');
const winston = require('winston');
const BN = require('bignumber.js');
const diff2 = BN('ffffffff', 16);


const server = http.createServer(app);
const io = require('socket.io').listen(server);
const bodyParser = require('body-parser');
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

app.get('/', function(req, res) {
	res.sendFile(path.resolve(__dirname+'/index.html'));
});

const logger = new (winston.Logger)({
	transports: [
		new winston.transports.Console({timestamp:(new Date()).toLocaleTimeString(),colorize:true,level:'info'}),
		new winston.transports.File({name:'a',json:false,filename:'logfile.txt',timestamp:(new Date()).toLocaleTimeString(),level:'debug'}),
	]
});

const switchEmitter = new events.EventEmitter();
switchEmitter.setMaxListeners(200);

process.on("uncaughtException", function(error) {
	logger.error(error);
});

var config = JSON.parse(fs.readFileSync('config.json'));
const localport = config.workerport;
var pools = config.pools;

var workerhashrates = {};

logger.info("start http interface on port %d ", config.httpport);
server.listen(config.httpport,'::');

function attachPool(localsocket,coin,firstConn,setWorker,user,pass) {

	var idx;
	for (var pool in pools[user]) if (pools[user][pool].symbol === coin) idx = pool;

	logger.info('connect to %s %s ('+pass+')',pools[user][idx].host, pools[user][idx].port);
	
	var remotesocket = new net.Socket();
	remotesocket.connect(pools[user][idx].port, pools[user][idx].host);

	var poolDiff=0;
	const connectTime = ((new Date).getTime())/1000;
	var shares=0;

	remotesocket.on('connect', function (data) {
		
		if(data) logger.debug('received from pool ('+coin+') on connect:'+data.toString().trim()+' ('+pass+')');
		
		logger.info('new login to '+coin+' ('+pass+')');
		var request = {"id":1,"method":"login","params":{"login":pools[user][idx].name,"pass":pass,"agent":"XMRig/2.5.0"}};
		remotesocket.write(JSON.stringify(request)+"\n");
		
	});
	
	remotesocket.on('data', function(data) {

		if(data)logger.debug('received from pool ('+coin+'):'+data.toString().trim()+' ('+pass+')');

		var request = JSON.parse(data);
		

		if(request.result && request.result.job)
		{
			var mybuf = new  Buffer(request.result.job.target, "hex");
			
			poolDiff = diff2.div(BN(mybuf.reverse().toString('hex'),16)).toFixed(0);
			
			logger.info('login reply from '+coin+' ('+pass+') (diff: '+poolDiff+')');

			setWorker(request.result.id);

			if(! firstConn)
			{

				logger.info('  new job from login reply ('+pass+')');
				var job = request.result.job;

				
				request = {
								"jsonrpc":"2.0",
								"method":"job",
								"params":job
							};
			}
			firstConn=false;
		}
		else if(request.result && request.result.status === 'OK')
		{
			logger.info('    share deliverd to '+coin+' '+request.result.status+' ('+pass+')');
		}
		else if(request.method && request.method === 'job')
		{
			var mybuf = new  Buffer(request.params.target, "hex");
			poolDiff = diff2.div(BN(mybuf.reverse().toString('hex'),16)).toFixed(0);
			
			logger.info('New Job from pool '+coin+' ('+pass+') (diff: '+poolDiff+')');
		}
		else if(request.method) 
		{
			logger.info(request.method+' (?) from pool '+coin+' ('+pass+')');
		}else{
			logger.info(data+' (else) from '+coin+' '+JSON.stringify(request)+' ('+pass+')');
		}
			
		localsocket.write(JSON.stringify(request)+"\n");
	});
	
	remotesocket.on('close', function(had_error,text) {
		logger.info("pool conn to "+coin+" ended ("+pass+')');
		if(workerhashrates[user]) delete workerhashrates[user][pass];
		if(had_error) logger.error(' --'+text);
	});
	remotesocket.on('error', function(text) {
		logger.error("pool error "+coin+' ('+pass+')',text);
		
		//set pool dirty of happens multiple times
		//send share reject
		//switchEmitter.emit('switch',coin);
	});

	var poolCB = function(type,data){

		if(type === 'stop')
		{
			if(remotesocket) remotesocket.end();
			logger.info("stop pool conn to "+coin+' ('+pass+')');
		}
		else if(type === 'push')
		{
			if(data.method && data.method === 'submit') 
			{
				shares+=poolDiff/1000;
				
				const now = ((new Date).getTime())/1000;
				const rate = shares / (now-connectTime);

				if(!workerhashrates[user]) workerhashrates[user]={};

				workerhashrates[user][pass]={time:now,hashrate:rate};

				logger.info('   HashRate:'+((rate).toFixed(2))+' kH/s');
			}
			remotesocket.write(JSON.stringify(data)+"\n");
		}
	}

	return poolCB;
};

function createResponder(localsocket,user,pass){

	var myWorkerId;

	var connected = false;

	var idCB = function(id){
		logger.info(' set worker response id to '+id+' ('+pass+')');
		myWorkerId=id;
		connected = true;
	};

	var poolCB = attachPool(localsocket,pools[user].default||config.default,true,idCB,user,pass);

	var switchCB = function(newcoin,newuser){

		if(user!==newuser) return;

		logger.info('-- switch worker to '+newcoin+' ('+pass+')');
		connected = false;
		
		poolCB('stop');
		poolCB = attachPool(localsocket,newcoin,false,idCB,user,pass);
	};
	
	switchEmitter.on('switch',switchCB);

	var callback = function(type,request){
	
		if(type === 'stop')
		{
			poolCB('stop');
			logger.info('disconnect from pool ('+pass+')');
			switchEmitter.removeListener('switch', switchCB);
		}
		else if(request.method && request.method === 'submit') 
		{
			request.params.id=myWorkerId;
			logger.info('  Got share from worker ('+pass+')');
			
			var mybuf = new  Buffer(request.params.result, "hex");


			//logger.warn(mybuf);
			//var hashArray = mybuf;
			//var hashNum = bignum.fromBuffer(hashArray.reverse());
			//var hashDiff = diff1.div(hashNum);
			//logger.warn(hashDiff);


			if(connected) poolCB('push',request);
		}else{
			logger.info(request.method+' from worker '+JSON.stringify(request)+' ('+pass+')');
			if(connected) poolCB('push',request);
		}
	}

	return callback;
};

const workerserver = net.createServer(function (localsocket) {
	
	workerserver.getConnections(function(err,number){
		logger.info(">>> connection #%d from %s:%d",number,localsocket.remoteAddress,localsocket.remotePort);
	});

	var responderCB;

	localsocket.on('data', function (data) {
		
		if(data) logger.debug('received from woker ('+localsocket.remoteAddress+':'+localsocket.remotePort+'):'+data.toString().trim());
		var request = JSON.parse(data);
		
		if(request.method === 'login')
		{
			logger.info('got login from worker %s %s',request.params.login,request.params.pass);
			responderCB = createResponder(localsocket,request.params.login,request.params.pass);
		
		}else{
			if(!responderCB)
			{
				logger.warn('something before login '+JSON.stringify(request));
			}
			else
			{
				responderCB('push',request);
			}
		}
	});
	
	localsocket.on('error', function(text) {
		logger.error("worker error ",text);
		if(!responderCB)
		{
			logger.error('error before login');
		}
		else
		{
			responderCB('stop');
		}
	});

	localsocket.on('close', function(had_error) {
		
		if(had_error) 
			logger.error(error)
		else
			workerserver.getConnections(function(err,number){
				logger.info("worker connection ended - connections left:"+number);
			});
	
		if(!responderCB)
		{
			logger.warn('close before login');
		}
		else
		{
			responderCB('stop');
		}
	});

});

workerserver.listen(localport);

logger.info("start mining proxy on port %d ", localport);

io.on('connection', function(socket){
	
	var intervalObj;

	socket.on('reload',function(user) {
		config = JSON.parse(fs.readFileSync('config.json'));
		pools = config.pools;
		
		var coins = [];
		for (var pool of pools[user]) 
			coins.push({
				symbol:pool.symbol,
				login:pool.name.split('.')[0],
				url:pool.url,
				api:pool.api,
				active:((pools[user].default||config.default)===pool.symbol)?1:0
			});

		socket.emit('coins',coins);
		logger.info("pool config reloaded");
	});
	socket.on('user',function(user) {
		var coins = [];
		for (var pool of pools[user]) 
			coins.push({
				symbol:pool.symbol,
				login:pool.name.split('.')[0],
				url:pool.url?pool.url:'',
				api:pool.api?pool.api:'',
				active:((pools[user].default||config.default)===pool.symbol)?1:0
			});

		socket.emit('coins',coins);
		logger.info('-> current for '+user+': '+(pools[user].default||config.default));
		socket.emit('workers',workerhashrates[user]||{},((new Date).getTime())/1000);
		if(intervalObj) clearInterval(intervalObj);
		intervalObj = setInterval(() => {
			socket.emit('active',(pools[user].default||config.default));
			socket.emit('workers',workerhashrates[user]||{},((new Date).getTime())/1000);
		}, 2000);
	});

	socket.on('switch', function(user,coin){
		logger.info('->'+coin+' ('+user+')');
		pools[user].default=coin;
		switchEmitter.emit('switch',coin,user);
		socket.emit('active',coin);
	});

	socket.on('disconnect', function(reason){
		if(intervalObj) clearInterval(intervalObj);
	});

});
