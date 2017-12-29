const net = require("net");
const events = require('events');
const fs = require('fs');
const express = require('express');
const app = require('express')();
const http = require('http');
const path = require('path');
const winston = require('winston');


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
switchEmitter.setMaxListeners(100);

process.on("uncaughtException", function(error) {
	logger.error(error);
});

var config = JSON.parse(fs.readFileSync('config.json'));
const localport = config.workerport;
var pools = config.pools;

logger.info("start http interface on port %d ", config.httpport);
server.listen(config.httpport,'::');

var curr_height;
var curr_diff;

function attachPool(localsocket,coin,firstConn,setWorker) {

	var idx;
	for (var pool in pools) if (pools[pool].symbol === coin) idx = pool;

	logger.info('connect to %s %s',pools[idx].host, pools[idx].port);
	
	var remotesocket = new net.Socket();
	remotesocket.connect(pools[idx].port, pools[idx].host);

	remotesocket.on('connect', function (data) {
		
		if(data) logger.debug('received from pool ('+coin+') on connect:'+data.toString().trim());
		
		logger.info('new login to '+coin);
		var request = {"id":1,"method":"login","params":{"login":pools[idx].name,"pass":"x","agent":"XMRig/2.4.3"}};
		remotesocket.write(JSON.stringify(request)+"\n");
	});
	
	remotesocket.on('data', function(data) {

		if(data)logger.debug('received from pool ('+coin+'):'+data.toString().trim());

		var request = JSON.parse(data);

		if(request.result && request.result.job)
		{
			logger.info('login reply from '+coin);

			setWorker(request.result.id);

			if(! firstConn)
			{
				logger.info('  new job from login reply');
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
			logger.info('    share deliverd to '+coin+' '+request.result.status);
		}
		else if(request.method) 
		{
			logger.info(request.method+' from pool '+coin);
		}else{
			logger.info(data+' (else) from '+coin+' '+JSON.stringify(request));
		}
			
		localsocket.write(JSON.stringify(request)+"\n");
	});
	
	remotesocket.on('close', function(had_error,text) {
		logger.info("pool conn to "+coin+" ended");
		if(had_error) logger.error(' --'+text);
	});
	remotesocket.on('error', function(text) {
		logger.error("pool error "+coin+" ",text);
		//set pool dirty of happens multiple times
		//send share reject
		switchEmitter.emit('switch',coin);
	});

	var poolCB = function(type,data){

		if(type === 'stop')
		{
			if(remotesocket) remotesocket.end();
			logger.info("stop pool conn to "+coin);
		}
		else if(type === 'push')
		{
			remotesocket.write(data);
		}
	}

	return poolCB;
};

function createResponder(localsocket){

	var myWorkerId;

	var connected = false;

	var idCB = function(id){
		logger.info(' set worker response id to '+id);
		myWorkerId=id;
		connected = true;
	};

	var poolCB = attachPool(localsocket,config.default,true,idCB);

	var switchCB = function(newcoin){

		logger.info('-- switch worker to '+newcoin);
		connected = false;
		
		poolCB('stop');
		poolCB = attachPool(localsocket,newcoin,false,idCB);
	};
	
	switchEmitter.on('switch',switchCB);

	var callback = function(type,request){
	
		if(type === 'stop')
		{
			poolCB('stop');
			logger.info('disconnect from pool');
			switchEmitter.removeListener('switch', switchCB);
		}
		else if(request.method && request.method === 'submit') 
		{
			request.params.id=myWorkerId;
			logger.info('  Got share from worker');
			if(connected) poolCB('push',JSON.stringify(request)+"\n");
		}else{
			logger.info(request.method+' from worker '+JSON.stringify(request));
			if(connected) poolCB('push',JSON.stringify(request)+"\n");
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
			responderCB = createResponder(localsocket);
		
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

	var coins = [];
	for (var pool of pools) coins.push(pool.symbol);

	socket.emit('coins',coins);
	socket.emit('block','itns',curr_height,curr_diff);	

	socket.on('reload',function() {
		config = JSON.parse(fs.readFileSync('config.json'));
		pools = config.pools;
		var coins = [];
		for (var pool of pools) coins.push(pool.symbol);
		socket.emit('coins',coins);
		logger.info("pool config reloaded");
	});

	socket.on('switch', function(coin){
		logger.info('->'+coin);
		socket.emit('active',coin);
		switchEmitter.emit('switch',coin);
		config.default=coin;
	});
});
