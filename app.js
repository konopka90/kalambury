Array.prototype.remove = function() {
    var what, a = arguments, L = a.length, ax;
    while (L && this.length) {
        what = a[--L];
        while ((ax = this.indexOf(what)) !== -1) {
            this.splice(ax, 1);
        }
    }
    return this;
};

var express = require('express');
var app = express();
var serv = require('http').Server(app);

app.get('/', function(req, res) {
	res.sendFile(__dirname + '/client/index.html');
});

app.use('/client', express.static(__dirname + '/client'));

serv.listen(8080);
console.log("Server started.");

var Player = function(id, socket_id, nick) {
	var self = {
		id: id,
		socket_id: socket_id,
		nick: nick,
		points: 0,
	}
	
	return self;
	
};

var GameState = function() {
	
	var self = {
		state: 'WAITING_FOR_PLAYERS',		
	};
	
	return self;
};

var io = require('socket.io')(serv, {});
var SOCKET_LIST = {};
var DRAWING_QUEUE = [];
var PLAYER_LIST = {};
var WHITE_BOARD = [];
var GAME_STATE = GameState();
var POINTS_TO_WIN = 500;


function registerNewPlayer(socket) {
	let id = Math.random().toString(36);
	let nick = Math.random().toString(36).substring(7) + "" + Math.floor(Math.random() * 10000);
	var player = Player(id, socket.id, nick);
	PLAYER_LIST[id] = player;
	socket.player_id = player.id;
	socket.emit('newPlayerId', { id: id });
	console.log("New player registered " + player.nick);
}

function getSocketsCountByPlayerId(id) {
	let counter = 0;
	for (var i in SOCKET_LIST) {
		if (SOCKET_LIST[i].player_id === id) {
			counter = counter + 1;
		}
	}
	
	return counter;
}

function isPlayerInQueue(id) {
	for (var i in DRAWING_QUEUE) {
		if (DRAWING_QUEUE[i] == id) {
			return true;
		}
	}
	
	return false;
}

io.sockets.on('connection', function(socket) {	

	socket.id = Math.random();
	SOCKET_LIST[socket.id] = socket;
	
	socket.on('registerNewPlayer', function() { 
		registerNewPlayer(socket);
	});
			
			
	socket.on('getPlayerDetails', function(data) { 
		var player = PLAYER_LIST[data.id];
		if (player == null) {
			console.log("Player ID = " + data.id + " not found. Registering new player");
			registerNewPlayer(socket);
		} else {
			player.socket_id = socket.id;
			socket.player_id = player.id;
			SOCKET_LIST[socket.id] = socket;
			PLAYER_LIST[data.id] = player;
			console.log("Sending player details to player = " + player.nick);
			socket.emit('playerDetails', player);
		}		
	});
	
	socket.on('updateNick', function(data) { 
		socket.emit('updatedNick', { nick: data.nick });
		PLAYER_LIST[data.id].nick = data.nick;
		console.log("Nick " + data.oldNick + " changed to " + data.nick);
		
		for (var i in SOCKET_LIST) {
			let anotherSocket = SOCKET_LIST[i];
			sendSystemMessage(anotherSocket, "Gracz " + data.oldNick + " zmienił nick na " + data.nick);
		}
	});
	
	socket.on('disconnect', function() {
		delete SOCKET_LIST[socket.id];
		if (socket.player_id != null) {
			var player = PLAYER_LIST[socket.player_id];
			if (player != null && getSocketsCountByPlayerId(player.id) == 0 && isPlayerInQueue(player.id)) {
				console.log("Removing " + player.nick + " from queue, reason: disconnected");
				DRAWING_QUEUE.remove(player.id);
			}
		}
	});
	
	socket.on('chatMessage', function(data) {
		var player = PLAYER_LIST[data.id];
				
		/** Update chat **/
		for (var i in SOCKET_LIST) {
			let anotherSocket = SOCKET_LIST[i];
			anotherSocket.emit('updateChatWithMessageFromPlayer', { message: data.message, nick: player.nick } );			
		}
		
		console.log('Received message from ' + player.nick  + ' : ' + data.message);
		processChatMessage(data);
	});
	
	socket.on('wantToDraw', function(data) {
		var player = PLAYER_LIST[data.id];
		if (player == null) {
			return;
		}
		
		if (data.wantToDraw == true) {
			DRAWING_QUEUE.push(data.id);
			socket.emit('positionInQueue', { positionInQueue: DRAWING_QUEUE.length } );
			console.log("Adding " + player.nick + " to queue, position in queue: " + DRAWING_QUEUE.length );
		} else {
			console.log("Removing " + player.nick + " from queue");
			DRAWING_QUEUE.remove(player.id);			
		}
		
		sendUpdatedGameState();
	});
	
	socket.on('drawing', function(data) {
		WHITE_BOARD.push(data);
		for (var i in SOCKET_LIST) {
			var socket = SOCKET_LIST[i];
			socket.emit('drawing', data);
		}
	});
	
	socket.on('getWhiteboard', function() {
		socket.emit('whiteboard', WHITE_BOARD);
	});
	
	socket.on('resetWhiteboardRequest', function() {
		WHITE_BOARD = [];
		for (var i in SOCKET_LIST) {
			var s = SOCKET_LIST[i];
			s.emit('resetWhiteboard');
		}
	});
	
	socket.on('giveUp', function(data) {
		for (var i in SOCKET_LIST) {
			var player = PLAYER_LIST[data.id];
			sendSystemMessage(SOCKET_LIST[i], "Gracz " + PLAYER_LIST[data.id].nick + " zrezygnował z rysowania"); 
		}
	});
	
	socket.on('startGame', function() {
		if (GAME_STATE.state == 'WAITING_FOR_PLAYERS') {
			startGame();
		}
	});
	
	socket.on('stopGame', function() {
		if (GAME_STATE.state == 'GAME_IN_PROGRESS') {
			stopGame();
		}
	});
	
	socket.on('getGameState', function() {
		socket.emit('updateGameState', GAME_STATE);
	});
	
	function sendSystemMessage(socket, message) {
		socket.emit('updateChatWithSystemMessage', { message: message });
	}
	
	function startGame() {
		console.log("Game started!");
						
		/** Clear players points **/
		for (var i in PLAYER_LIST) {
			PLAYER_LIST[i].points = 0;
		}
		
		/** Clear queue **/
		DRAWING_QUEUE = [];
		
		GAME_STATE.state = 'GAME_IN_PROGRESS';
		
		/** Send message to players **/
		for (var i in SOCKET_LIST) {
			sendSystemMessage(SOCKET_LIST[i], "Gra rozpoczęta");
		}
		
		sendUpdatedGameState();
	}
	
	function stopGame() {
		console.log("Game stopped...");
		
		GAME_STATE.state = 'WAITING_FOR_PLAYERS';
		
		/** Send End message to players **/
		for (var i in SOCKET_LIST) {
			sendSystemMessage(SOCKET_LIST[i], "Gra zakończona"); 
		}
		
		sendUpdatedGameState();
	}
	
	function sendUpdatedGameState() {
		/** Send message to players **/
		for (var i in SOCKET_LIST) {
			SOCKET_LIST[i].emit('updateGameState', GAME_STATE);
			console.log("Updated game status: " + GAME_STATE.state);
		}
	}
	
	function processChatMessage(data) {
		
		/** Game must be in progress ! **/
		if (GAME_STATE.state != 'GAME_IN_PROGRESS') {
			return;
		}
		
		/** Check if someone won **/
		
		var player = PLAYER_LIST[data.id];
		player.points = player.points + 1;
		
		if (player.points >= POINTS_TO_WIN) {
			stopGame();
			
			/** Winner ! **/
			for (var i in SOCKET_LIST) {
				sendSystemMessage(SOCKET_LIST[i], "WYGRAŁ GRACZ " + player.nick + "!!!!!!!!!!"); 
			}

		}
		
		sendUpdatedGameState();
	}
	
});

// Update lobby list
setInterval(function() {
	
	// Get all players
	let lobby = []; 
	for (var i in SOCKET_LIST) {
		var socket = SOCKET_LIST[i];
		var player = PLAYER_LIST[socket.player_id];
		if (player != null) {
			lobby.push({nick: player.nick, points: player.points});
		}
	}
	
	// Send updated list
	for (var i in SOCKET_LIST) {
		var socket = SOCKET_LIST[i];
		socket.emit('updateLobby', lobby);
	}
	
}, 1000/1);

