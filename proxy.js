var net = require("net");
var events = require('events');
var fs = require('fs');
var express = require('express');
var app = require('express')();
var http = require('http');
var path = require('path');


var server = http.createServer(app);
var io = require('socket.io').listen(server);
var bodyParser = require('body-parser');
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

app.get('/', function(req, res) {
	res.sendFile(path.resolve(__dirname+'/index.html'));
});



var switchEmitter = new events.EventEmitter();


process.on("uncaughtException", function(error) {
	console.error(error);
});


var config = JSON.parse(fs.readFileSync('config.json'));
var localport = config.workerport;
var pools = config.pools;

console.log("start http interface on port %d ", config.httpport);
server.listen(config.httpport,'78.46.85.142');
	


function attachPool(localsocket,coin,firstConn,setWorker) {

	var idx;
	for (var pool in pools) if (pools[pool].symbol === coin) idx = pool;

	console.log(idx);

	console.log('connect to %s %s',pools[idx].host, pools[idx].port);
	
	var remotesocket = new net.Socket();
	remotesocket.connect(pools[idx].port, pools[idx].host);

	remotesocket.on('connect', function (data) {

		console.log('new login to '+coin);
		var request = {"method":"login","params":{"login":pools[idx].name,"pass":"x","agent":"cast_xmr/0.8.0"},"id":1};
		remotesocket.write(JSON.stringify(request)+"\r\n");
	});
	
	remotesocket.on('data', function(data) {

		var request = JSON.parse(data);

		if(request.result && request.result.job)
		{
			console.log('login reply from '+coin);

			setWorker(request.result.id);

			if(! firstConn)
			{
				console.log('  new job from login reply');
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
			console.log('    share deliverd to '+coin+' '+request.result.status);
		}
		else if(request.method) 
		{
			console.log(request.method+' from pool '+coin);
		}else{
			console.log(data+' (else) from '+coin+' '+JSON.stringify(request));
		}
			
		localsocket.write(JSON.stringify(request)+"\r\n");
	});
	
	
	remotesocket.on('close', function(had_error,text) {
		console.log("pool conn to "+coin+" ended");
		if(had_error) console.log(' --'+text);
	});
	remotesocket.on('error', function(text) {
		console.log("pool error "+coin+" ",text);
	});


	var poolCB = function(type,data){

		if(type === 'stop')
		{
			if(remotesocket) remotesocket.end();
			console.log("stop pool conn");
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
		console.log(' set worker response id to '+id);
		myWorkerId=id;
		connected = true;
	};

	var poolCB = attachPool(localsocket,config.default,true,idCB);

	var switchCB = function(newcoin){

		console.log('-- switch worker to '+newcoin);
		connected = false;
		
		poolCB('stop');
		poolCB = attachPool(localsocket,newcoin,false,idCB);
	
	};
	
	switchEmitter.on('switch',switchCB);

	var callback = function(type,request){
	
		if(type === 'stop')
		{
			poolCB('stop');
			console.log('disconnect from pool');
			switchEmitter.removeListener('switch', switchCB);
		}
		else if(request.method && request.method === 'submit') 
		{
			request.params.id=myWorkerId;
			console.log('  Got share from worker');
			if(connected) poolCB('push',JSON.stringify(request)+"\r\n");
		}else{
			console.log(request.method+' from worker '+JSON.stringify(request));
			if(connected) poolCB('push',JSON.stringify(request)+"\r\n");
		}
	
	}

	return callback;
};

var server = net.createServer(function (localsocket) {
	
	server.getConnections(function(err,number){
		console.log(">>> connection #%d from %s:%d",number,localsocket.remoteAddress,localsocket.remotePort);
	});

	var responderCB;

	localsocket.on('data', function (data) {

		var request = JSON.parse(data);
		
		if(request.method === 'login')
		{
			console.log('got login from worker %s %s',request.params.login,request.params.pass);
			responderCB = createResponder(localsocket);
		
		}else{
			if(!responderCB)
			{
				console.log('something before login '+JSON.stringify(request));
			}
			else
			{
				responderCB('push',request);
			}
		}
	});
	
	localsocket.on('error', function(text) {
		console.log("worker error ",text);
		if(!responderCB)
		{
			console.log('error before login');
		}
		else
		{
			responderCB('stop');
		}
	});

	localsocket.on('close', function(had_error) {
		console.log("worker gone "+had_error);
	
		if(!responderCB)
		{
			console.log('close before login');
		}
		else
		{
			responderCB('stop');
		}
	});

});

server.listen(localport);

console.log("start mining proxy on port %d ", localport);

io.on('connection', function(socket){

	var coins = [];
	for (var pool of pools) coins.push(pool.symbol);
	var actice = config.default;

	socket.emit('coins',coins);

	socket.on('switch', function(coin){
		console.log('->'+coin);
		socket.emit('active',coin);
		switchEmitter.emit('switch',coin);
	});
});

