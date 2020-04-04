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

/** Server **/

var express = require('express');
var app = express();
var serv = require('http').Server(app);

app.get('/', function(req, res) {
	res.sendFile(__dirname + '/client/index.html');
});

app.use('/client', express.static(__dirname + '/client'));

const PORT = process.env.PORT || 8080;
serv.listen(PORT);
console.log("Server started.");

/** Read questions **/

var QUESTIONS = require('fs').readFileSync('./questions.txt', 'utf-8')
	.split('\n')
	.filter(Boolean);


/** Game variables **/

var Player = function(id, socket_id, nick) {
	var self = {
		id: id,
		socket_id: socket_id,
		nick: nick,
		points: 0,
		want_to_draw: false,
		last_seen: (new Date()).getTime()
	}
	
	return self;
	
};

var GameState = function() {
	
	var self = {
		state: 'WAITING_FOR_PLAYERS',
		drawingPlayerId: null,
		question: null
	};
	
	return self;
};

var io = require('socket.io')(serv, {});
var SOCKET_LIST = {};
var DRAWING_QUEUE = [];
var PLAYER_LIST = {};
var WHITE_BOARD = [];
var GAME_STATE = GameState();
var POINTS_TO_WIN = 6;
var QUESTION_WORDS_PREFIXES = [];
var MAX_SECONDS = 30;
var TIMER = null;
var TIME_LEFT = 0;
var PLAYER_TIMEOUT = 15 * 1000;

/** Event bus **/

var EVENT_BUS_SERVER = require('http').Server(app);
EVENT_BUS_SERVER.listen(7000);
var EVENT_BUS = require('socket.io')(EVENT_BUS_SERVER);
var EVENT_BUS_CLIENT = require("socket.io-client").connect("http://localhost:7000");

EVENT_BUS.sockets.on('connection', function(EVENT_SOCKET) {
	
	console.log('Event bus connected');
	
	EVENT_SOCKET.on('SERVER_STARTED', function() {
		/** Clear players points **/
		for (var i in PLAYER_LIST) {
			PLAYER_LIST[i].points = 0;
		}
		
		/** Clear queue **/
		DRAWING_QUEUE = [];
				
		/** Send message to players **/
		sendSystemMessageToAll("Gra rozpoczęta");
		
		GAME_STATE.state = 'GAME_STARTED';
		sendUpdatedGameStateToAll();
		EVENT_BUS_CLIENT.emit('LOOK_FOR_DRAWING_PLAYER');
	});
	
	EVENT_SOCKET.on('SERVER_STOPPED', function() {
		GAME_STATE.state = 'WAITING_FOR_PLAYERS';
		
		stopTimer();
		
		sendUpdatedGameStateToAll();
		
		/** Send End message to players **/
		sendSystemMessageToAll("Gra zakończona");
		sendPlayerDetailsToAll();
	});
	
	EVENT_SOCKET.on('LOOK_FOR_DRAWING_PLAYER', function() {
		GAME_STATE.state = 'LOOK_FOR_DRAWING_PLAYER';
		sendUpdatedGameStateToAll();
		stopTimer();
		
		if (DRAWING_QUEUE.length == 0) {
			EVENT_BUS_CLIENT.emit('NOBODY_WANTS_TO_DRAW');
		} else {
			var playerId = DRAWING_QUEUE.shift();
			DRAWING_QUEUE.push(playerId);
			EVENT_BUS_CLIENT.emit('FIND_QUESTION', {  playerId: playerId });
		}
	});
	
	EVENT_SOCKET.on('NOBODY_WANTS_TO_DRAW', function() {
		GAME_STATE.state = 'NOBODY_WANTS_TO_DRAW';
		sendUpdatedGameStateToAll();
	});
	
	EVENT_SOCKET.on('PLAYER_ADDED_TO_QUEUE', function() { 
		if (GAME_STATE.state == 'NOBODY_WANTS_TO_DRAW') {
			EVENT_BUS_CLIENT.emit('LOOK_FOR_DRAWING_PLAYER');
		}
	});
	
	EVENT_SOCKET.on('FIND_QUESTION', function(data) { 
		let min = 0;
		let max = QUESTIONS.length - 1;
		let random = Math.floor(Math.random()*(max-min+1)+min);
		let new_question = QUESTIONS[random].trim().toLowerCase();		
		let question_words = new_question.split(' ');
		
		QUESTION_WORDS_PREFIXES = [];
		for (var i in question_words) {
			let word = question_words[i];
			QUESTION_WORDS_PREFIXES.push(word);
		}
		
		EVENT_BUS_CLIENT.emit('DRAWING', Object.assign(data, { question : new_question }));
	});
	
	EVENT_SOCKET.on('DRAWING', function(data) { 
		GAME_STATE.state = 'DRAWING';
		GAME_STATE.drawingPlayerId = data.playerId;
		GAME_STATE.question = data.question;
		console.log("Now is drawing " + PLAYER_LIST[data.playerId].nick);
		sendSystemMessageToAll("Teraz rysuje " + PLAYER_LIST[data.playerId].nick)
		clearWhiteboard();
		sendUpdatedGameStateToAll();
		sendPlayerDetailsToAll();
		startTimer();
	});
	
	EVENT_SOCKET.on('GIVE_UP', function() { 
		console.log('Giving up question');
		GAME_STATE.drawingPlayerId = null;
		EVENT_BUS_CLIENT.emit('LOOK_FOR_DRAWING_PLAYER');
	});
	
	EVENT_SOCKET.on('ANSWER', function(data) { 
		if (data.id === GAME_STATE.drawingPlayerId) {
			return;
		}
	
		let message = data.message.toLowerCase().trim();
		if (message === GAME_STATE.question && GAME_STATE.state == 'DRAWING') {
			GAME_STATE.state = 'GOOD_ANSWER';
			EVENT_BUS_CLIENT.emit('SMALL_WIN', { id: data.id });
		} else {
			let closeAnswers = isItCloseAnswer(message);
			if (closeAnswers.length > 0) {
				sendSystemMessageToAll("Blisko: " + closeAnswers.join(' '));
			}
		}
	});
	
	EVENT_SOCKET.on('SMALL_WIN', function(data) { 
		var playerWhoGuessed = PLAYER_LIST[data.id];
		var drawingPlayer = PLAYER_LIST[GAME_STATE.drawingPlayerId];
		GAME_STATE.drawingPlayerId = null;
		
		drawingPlayer.points = drawingPlayer.points + 2;
		playerWhoGuessed.points = playerWhoGuessed.points + 3;
		
		sendSystemMessageToAll("Hasło zgadł " + playerWhoGuessed.nick);
		EVENT_BUS_CLIENT.emit('CHECK_BIG_WIN');
		
	});
	
	
	EVENT_SOCKET.on('CHECK_BIG_WIN', function() { 
		let winner = null;
		let maxPoints = 0;
		for (var i in PLAYER_LIST) {
			if (PLAYER_LIST[i].points >= POINTS_TO_WIN && PLAYER_LIST[i].points > maxPoints) {
				maxPoints = PLAYER_LIST[i].points;
				winner = PLAYER_LIST[i];
			}
		}
		
		if (winner != null) {
			console.log("Winner is " + winner.nick);
			sendSystemMessageToAll("BRAWO !!! Zwycięzca: " + winner.nick);
			EVENT_BUS_CLIENT.emit('SERVER_STOPPED');
		} else {
			EVENT_BUS_CLIENT.emit('LOOK_FOR_DRAWING_PLAYER');
		}
	});
	
	EVENT_SOCKET.on('LOSE', function() { 
		GAME_STATE.state = 'LOSE';
		var player = PLAYER_LIST[GAME_STATE.drawingPlayerId];
		if (player != null) {
			player.points = player.points - 10;
		}
		
		GAME_STATE.drawingPlayerId = null;
		sendSystemMessageToAll("Nikt nie odgadł hasła <b>" + GAME_STATE.question.toUpperCase() + "</b>");
		EVENT_BUS_CLIENT.emit('LOOK_FOR_DRAWING_PLAYER');
	});
});


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
			player.last_seen = (new Date()).getTime();
			socket.player_id = player.id;
			
			SOCKET_LIST[socket.id] = socket;
			PLAYER_LIST[data.id] = player;
			console.log("Sending player details to player = " + player.nick);
			
			sendPlayerDetails(socket, player);
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
				// console.log("Removing " + player.nick + " from queue, reason: disconnected");
				// DRAWING_QUEUE.remove(player.id);
				player.last_seen = new Date().getTime();
			}
		}
	});
	
	socket.on('chatMessage', function(data) {
		var player = PLAYER_LIST[data.id];
		
		if (player == null) {
			return;
		}
				
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
		
		player.want_to_draw = data.wantToDraw;
		
		if (data.wantToDraw == true) {
			DRAWING_QUEUE.push(data.id);
			socket.emit('positionInQueue', { positionInQueue: DRAWING_QUEUE.length } );
			console.log("Adding " + player.nick + " to queue, position in queue: " + DRAWING_QUEUE.length );			
			
			// Fix for more equal drawing order
			if (DRAWING_QUEUE.length == 2) {
				let temp = DRAWING_QUEUE[0];
				DRAWING_QUEUE[0] = DRAWING_QUEUE[1];
				DRAWING_QUEUE[1] = temp;
			}
			
			
			EVENT_BUS_CLIENT.emit('PLAYER_ADDED_TO_QUEUE');
		} else {
			console.log("Removing " + player.nick + " from queue");
			DRAWING_QUEUE.remove(player.id);			
		}
			
		sendUpdatedGameStateToAll();
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
		clearWhiteboard();
	});
	
	socket.on('giveUp', function(data) {
		for (var i in SOCKET_LIST) {
			var player = PLAYER_LIST[data.id];
			sendSystemMessage(SOCKET_LIST[i], "Gracz " + PLAYER_LIST[data.id].nick + " zrezygnował z rysowania"); 
		}
		
		EVENT_BUS_CLIENT.emit('GIVE_UP');
	});
	
	socket.on('startServer', function() {
		if (GAME_STATE.state == 'WAITING_FOR_PLAYERS') {
			onStartServer();
		}
	});
	
	socket.on('stopServer', function() {
		if (GAME_STATE.state != 'WAITING_FOR_PLAYERS') {
			onStopServer();
		}
	});
	
	socket.on('getGameState', function() {
		socket.emit('updateGameState', GAME_STATE);
	});
	
	
	function onStartServer() {
		console.log("Game started!");
		EVENT_BUS_CLIENT.emit('SERVER_STARTED');
	}
	
	function onStopServer() {
		console.log("Game stopped...");
		EVENT_BUS_CLIENT.emit('SERVER_STOPPED');
	}
		
	function processChatMessage(data) {
		
		/** Game must be in progress ! **/
		if (GAME_STATE.state != 'DRAWING') {
			return;
		}
		
		EVENT_BUS_CLIENT.emit('ANSWER', data);
	}
	
});

function sendSystemMessageToAll(message) {
	for (var i in SOCKET_LIST) {
		SOCKET_LIST[i].emit('updateChatWithSystemMessage',  { message: message });
	}
}

function sendSystemMessage(socket, message) {
	socket.emit('updateChatWithSystemMessage', { message: message });
}

function sendUpdatedGameStateToAll() {
	for (var i in SOCKET_LIST) {
		SOCKET_LIST[i].emit('updateGameState', GAME_STATE);
	}
	
	console.log("Updated game status for players: " + GAME_STATE.state);
}

function clearWhiteboard() {
	WHITE_BOARD = [];
	for (var i in SOCKET_LIST) {
		var s = SOCKET_LIST[i];
		s.emit('resetWhiteboard');
	}
}

function isItCloseAnswer(message) {
	const messageWords = message.split(' ');
	let CLOSE_WORDS = [];
	for (var i in messageWords) {
		let wordToCheck = messageWords[i];
		for (var k in QUESTION_WORDS_PREFIXES) {
			let wordInQuestion = QUESTION_WORDS_PREFIXES[k];
			
			// I dont know why but last element in array is a function
			if (typeof wordInQuestion === 'function') {
				continue;
			}
			
			console.log("word in question " + wordInQuestion);
			if (wordInQuestion.length > 3 && wordToCheck.length >= 3 && wordInQuestion.startsWith(wordToCheck)) {
				CLOSE_WORDS.push(wordToCheck);
				continue;
			}
			
			if (wordInQuestion != '' && wordInQuestion.length <= 3 && wordToCheck.length == wordInQuestion.length && wordInQuestion.startsWith(wordToCheck)) {
				CLOSE_WORDS.push(wordToCheck);
				continue;
			}
		}
		
	}
	return CLOSE_WORDS;
}

function startTimer() {
	if (TIMER != null) {
		clearInterval(TIMER);
	}
	
	TIME_LEFT = MAX_SECONDS;
	TIMER = setInterval(function(){
		// Send update to all players
		for (var i in SOCKET_LIST) {
			var socket = SOCKET_LIST[i];
			socket.emit('updateTimer', { seconds: TIME_LEFT });
		}
		
		if(TIME_LEFT <= 0) {
			clearInterval(TIMER);
			if (GAME_STATE.state === 'DRAWING') {
				EVENT_BUS_CLIENT.emit('LOSE');
			}
			return;
		}
		TIME_LEFT -= 1;
		

	}, 1000);
}

function stopTimer() {
	if (TIMER != null) {
		clearInterval(TIMER);
	}
}

function isPlayerDrawing(id) {
	var player = PLAYER_LIST[id];
	return (player != null && GAME_STATE.drawingPlayerId != null && GAME_STATE.drawingPlayerId === player.id) || GAME_STATE.state === 'WAITING_FOR_PLAYERS';
}

function buildPlayerDetails(player) {
	return {
		id: player.id,
		nick: player.nick,
		question: isPlayerDrawing(player.id) ? GAME_STATE.question : '',
		isDrawing: isPlayerDrawing(player.id),
		wantToDraw: player.want_to_draw
	};
}

function sendPlayerDetails(socket, player) {
	socket.emit('playerDetails', buildPlayerDetails(player));
}

function sendPlayerDetailsToAll() {
	for (var i in SOCKET_LIST) {
		var player = PLAYER_LIST[SOCKET_LIST[i].player_id];
		if (player != null) {
			SOCKET_LIST[i].emit('playerDetails', buildPlayerDetails(player));
		}
	}
	
}

// Update lobby list
setInterval(function() {
	
	// Get all players
	let lobby = []; 
	let lobby_to_send = []; 
	for (var i in SOCKET_LIST) {
		var socket = SOCKET_LIST[i];
		var player = PLAYER_LIST[socket.player_id];
		if (player != null && !lobby.includes(player)) {
			var message = {nick: player.nick, points: player.points};
			lobby.push(player);
			lobby_to_send.push(message);
		}
	}
	
	// Send updated list
	for (var i in SOCKET_LIST) {
		var socket = SOCKET_LIST[i];
		socket.emit('updateLobby', lobby_to_send);
	}
	
}, 1000/1);


// Check if player timed out
setInterval(function() {
	for (var i in SOCKET_LIST) {
		var player = PLAYER_LIST[SOCKET_LIST[i].player_id];
		if (player != null) {
			player.last_seen = (new Date()).getTime();
		}
	}
	
	if (GAME_STATE.drawingPlayerId != null) {
		var player = PLAYER_LIST[GAME_STATE.drawingPlayerId];
		
		if (player != null) {
			var date = new Date();
			if (date.getTime() - player.last_seen > PLAYER_TIMEOUT) {
				console.log("Removing player " + player.nick + " from queue - timeout");
				DRAWING_QUEUE.remove(player.id);
				EVENT_BUS_CLIENT.emit('GIVE_UP');
			}
		}
	}
	
		
}, 1000)

