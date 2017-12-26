var net = require("net");
var events = require('events');
var fs = require('fs');

var switchEmitter = new events.EventEmitter();


process.on("uncaughtException", function(error) {
	console.error(error);
});



var io = require('socket.io')(16787);

var config = JSON.parse(fs.readFileSync('config.json'));
var localport = config.port;
var login = config.login;



function attachPool(localsocket,coin,firstConn,setWorker) {
	
	console.log('connect to %s %s',login[coin].host, login[coin].port);
	
	var remotesocket = new net.Socket();
	remotesocket.connect(login[coin].port, login[coin].host);

	remotesocket.on('connect', function (data) {

		console.log('new login to '+coin);
		var request = {"method":"login","params":{"login":login[coin].name,"pass":"x","agent":"cast_xmr/0.8.0"},"id":1};
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

	var callback = function(request){
	
		if(request === 'stop')
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

io.on('connection', function(socket){
	socket.on('a', function(){
		switchEmitter.emit('switch','etn');
	});
	socket.on('b', function(){
		switchEmitter.emit('switch','itns');
	});
	socket.on('c', function(){
		switchEmitter.emit('switch','xun');
	});
	socket.on('d', function(){
		switchEmitter.emit('switch','msr');
	});
	socket.on('e', function(){
	});
	socket.on('f', function(){
		switchEmitter.emit('switch','nh');
	});
});


function createNewWorker(localsocket){
	
	var callback;

	localsocket.on('data', function (data) {

		var request = JSON.parse(data);
		
		if(request.method === 'login')
		{
			console.log('got login from worker %s %s',request.params.login,request.params.pass);
			callback = createResponder(localsocket);
		
		}else{
			if(!callback)
			{
				console.log('something before login '+JSON.stringify(request));
			}
			else
			{
				callback(request);
			}
		}
	});
	
	localsocket.on('error', function(text) {
		console.log("worker error ",text);
		if(!callback)
		{
			console.log('end before login');
		}
		else
		{
			callback('stop');
		}
	});

	localsocket.on('close', function(had_error) {
		console.log("worker gone "+had_error);
	
		if(!callback)
		{
			console.log('end before login');
		}
		else
		{
			callback('stop');
		}
	});

};

var server = net.createServer(function (localsocket) {
	
	server.getConnections(function(err,number){
		console.log(">>> connection #%d from %s:%d",number,localsocket.remoteAddress,localsocket.remotePort);
	});

	createNewWorker(localsocket);

});

server.listen(localport);

console.log("start mining proxy on port %d ", localport);

