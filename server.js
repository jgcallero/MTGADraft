"use strict";

const port = process.env.PORT || 3000
const express = require('express'); 
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const cookieParser = require('cookie-parser');
const uuidv1 = require('uuid/v1');
const fs = require('fs');

const MTGSets = ["m19", "xln", "rix", "dom", "grn", "rna", "war", "m20", "eld"];

app.use(cookieParser()); 

function isEmpty(obj) {
	return Object.entries(obj).length === 0 && obj.constructor === Object;
}

function arrayRemove(arr, value) {
	return arr.filter(function(ele) {
	   return ele != value;
	});
}

function get_random(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

function get_random_key(dict) {
	return Object.keys(dict)[Math.floor(Math.random() * Object.keys(dict).length)];
}

function Session(id) {
	this.id = id;
	this.isPublic = false;
	this.users = new Set();
	this.collection = function () {
		// Compute collections intersection
		let user_list = [...this.users];
		let intersection = [];
		let collection = {};
		
		// If none of the user has uploaded their collection/doesn't want to use it, return all cards.
		let all_cards = true;
		for(let i = 0; i < user_list.length; ++i) {
			all_cards = all_cards && (!Connections[user_list[i]].useCollection || isEmpty(Connections[user_list[i]].collection));
		}
		if(all_cards) {
			for(let c of Object.keys(Cards))
				if(Cards[c].in_booster)
					collection[c] = 4;
			return collection;
		}
		
		// Start from the first user's collection, or the list of all cards if not available/used
		if(!Connections[user_list[0]].useCollection || isEmpty(Connections[user_list[0]].collection))
			intersection = Object.keys(Cards).filter(c => c in Cards && Cards[c].in_booster);
		else
			intersection = Object.keys(Connections[user_list[0]].collection).filter(c => c in Cards && Cards[c].in_booster);
		
		// Shave every useless card id
		for(let i = 1; i < user_list.length; ++i)
			if(Connections[user_list[i]].useCollection && !isEmpty(Connections[user_list[i]].collection))
				intersection = intersection.filter(value => Object.keys(Connections[user_list[i]].collection).includes(value))
		
		// Compute the minimum count of each remaining card
		for(let c of intersection) {
			if(!Connections[user_list[0]].useCollection || isEmpty(Connections[user_list[0]].collection))
				collection[c] = 4;
			else
				collection[c] = Connections[user_list[0]].collection[c];
			for(let i = 1; i < user_list.length; ++i)
				if(Connections[user_list[i]].useCollection && !isEmpty(Connections[user_list[i]].collection))
					collection[c] = Math.min(collection[c], Connections[user_list[i]].collection[c]);
		}
		return collection;
	};
	this.drafting = false;
	this.boostersPerPlayer = 3;
	this.bots = 0;
	this.setRestriction = "";
	this.boosters = [];
	this.round = 0;
	this.pickedCardsThisRound = 0;
}

let Sessions = {};
let Connections = {};

let Cards = JSON.parse(fs.readFileSync("public/data/MTGACards.json"));
for(let c in Cards) {
	if(!('in_booster' in Cards[c]))
		Cards[c].in_booster = true;
}

function getPublicSessions() {
	let publicSessions = [];
	for(let s in Sessions) {
		if(Sessions[s].isPublic) {
			publicSessions.push(s);
		}
	}
	return publicSessions;
}

io.on('connection', function(socket) {
	const query = socket.handshake.query;
	log(`${query.userName} [${query.userID}] connected. (${Object.keys(Connections).length + 1} players online)`);
	if(query.userID in Connections) {
		log(`${query.userName} [${query.userID}] already connected.`, FgRed);
		socket.emit('alreadyConnected');
		socket.disconnect(true);
		return;
	}
	
	Connections[query.userID] = {
		socket: socket,
		userID: query.userID,
		userName: query.userName,
		sessionID: query.sessionID,
		readyToDraft: false,
		collection: {},
		useCollection: true
	};
	
	if(query.sessionID in Sessions && Sessions[query.sessionID].drafting) {
		socket.emit('message', {title: 'Cannot join session', text: `This session (${query.sessionID}) is currently drafting. Please wait for them to finish.`});
		query.sessionID = uuidv1();
		socket.emit('setSession', query.sessionID);
	}
	
	addUserToSession(query.userID, query.sessionID);
	
	socket.userID = query.userID;
	
	socket.emit('publicSessions', getPublicSessions());
	
	// Messages
	
	socket.on('disconnect', function() {
		let userID = query.userID;
		if(userID in Connections) {
			log(`${Connections[userID].userName} [${userID}] disconnected. (${Object.keys(Connections).length - 1} players online)`, FgRed);
			removeUserFromSession(userID, Connections[userID].sessionID);
			delete Connections[userID];
		}
	});
	
	socket.on('setUserName', function(userName) {
		let userID = query.userID;
		Connections[userID].userName = userName;
		notifyUserChange(Connections[userID].sessionID);
	});

	socket.on('setSession', function(sessionID) {
		let userID = query.userID;
		
		if(sessionID == Connections[userID].sessionID)
			return;
		
		if(sessionID in Sessions && Sessions[sessionID].drafting) {
			socket.emit('message', {title: 'Cannot join session', text: `This session (${sessionID}) is currently drafting. Please wait for them to finish.`});
			socket.emit('setSession', Connections[userID].sessionID);
			return;
		}
		
		removeUserFromSession(userID, Connections[userID].sessionID);
		addUserToSession(userID, sessionID);
	});
	
	socket.on('setCollection', function(collection) {
		let userID = query.userID;
		
		if(typeof collection !== 'object' || collection === null)
			return;
		
		let sessionID = Connections[userID].sessionID;
		Connections[userID].collection = collection;
		notifyUserChange(sessionID);
	});
	
	socket.on('boostersPerPlayer', function(boostersPerPlayer) {
		let sessionID = Connections[this.userID].sessionID;
		
		if(isNaN(boostersPerPlayer))
			return;

		if(boostersPerPlayer == Sessions[sessionID].boostersPerPlayer)
			return;
		
		Sessions[sessionID].boostersPerPlayer = boostersPerPlayer;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('boostersPerPlayer', boostersPerPlayer);
		}
	});
	
	socket.on('bots', function(bots) {
		let sessionID = Connections[this.userID].sessionID;
		
		if(isNaN(bots))
			return;

		if(bots == Sessions[sessionID].bots)
			return;
		
		Sessions[sessionID].bots = bots;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('bots', bots);
		}
	});
	
	socket.on('useCollection', function(useCollection) {
		let userID = query.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(typeof useCollection !== 'boolean')
			return;

		if(useCollection == Connections[userID].useCollection)
			return;
		
		Connections[userID].useCollection = useCollection;
		notifyUserChange(sessionID);
	});
	
	socket.on('setRestriction', function(setRestriction) {
		let sessionID = Connections[this.userID].sessionID;
		
		if(setRestriction !== '' && MTGSets.indexOf(setRestriction) == -1)
			return;

		if(setRestriction == Sessions[sessionID].setRestriction)
			return;
		
		Sessions[sessionID].setRestriction = setRestriction;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('setRestriction', setRestriction);
		}
	});
	
	socket.on('setPublic', function(isPublic) {
		let sessionID = Connections[this.userID].sessionID;
		
		if(isPublic == Sessions[sessionID].isPublic)
			return;
		
		Sessions[sessionID].isPublic = isPublic;	
		// Update all clients
		io.emit('publicSessions', getPublicSessions());
	});
	
	socket.on('readyToDraft', function(readyToDraft) {
		let userID = query.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(typeof readyToDraft !== 'boolean')
			return;
		
		Connections[userID].readyToDraft = readyToDraft;
		
		let allReady = true;
		for(let user of Sessions[sessionID].users) {
			if(!Connections[user].readyToDraft) {
				allReady = false;
				break;
			}
		}
		
		if(allReady && Sessions[sessionID].users.size + Sessions[sessionID].bots >= 2) {
			startDraft(sessionID);
		}
		
		notifyUserChange(sessionID);
	});
	
	socket.on('distributeSealed', function(boostersPerPlayer) {
		let userID = query.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(isNaN(boostersPerPlayer))
			return;
		
		emitMessage(sessionID, 'Distributing sealed boosters...', '', false);
		
		for(let user of Sessions[sessionID].users) {
			if(!generateBoosters(sessionID, boostersPerPlayer)) {
				return;
			}
			Connections[user].socket.emit('setCardSelection', Sessions[sessionID].boosters);
		}
		Sessions[sessionID].boosters = [];
	});
	
	// Removes picked card from corresponding booster and notify other players.
	// Moves to next round when each player have picked a card.
	socket.on('pickCard', function(sessionID, boosterIndex, cardID) {
		let userID = query.userID;
		
		if(!(sessionID in Sessions) || 
		   !(userID in Connections) || 
		   boosterIndex > Sessions[sessionID].boosters.length)
			return;
		
		log(`Session ${sessionID}: ${Connections[userID].userName} [${userID}] picked card ${cardID} from booster n°${boosterIndex}.`);
		
		// Removes the first occurence of cardID
		for(let i = 0; i < Sessions[sessionID].boosters[boosterIndex].length; ++i) {
			if(Sessions[sessionID].boosters[boosterIndex][i] == cardID) {
				Sessions[sessionID].boosters[boosterIndex].splice(i, 1);
				break;
			}
		}
		
		// Signal users
		for(let user of Sessions[sessionID].users)
			Connections[user].socket.emit('signalPick', userID);
		
		++Sessions[sessionID].pickedCardsThisRound;
		if(Sessions[sessionID].pickedCardsThisRound == Sessions[sessionID].users.size) {
			nextBooster(sessionID);
		}
	});
});

function generateBoosters(sessionID, boosterQuantity) {
	let sess = Sessions[sessionID];
	// Getting intersection of players' collections
	let collection = sess.collection();
	// Order by rarity
	let localCollection = {'common':{}, 'uncommon':{}, 'rare':{}, 'mythic':{}};
	for(let c in collection) {
		if(!(c in Cards)) {
			log(`Warning: Card ${c} not in database.`, FgYellow);
			continue;
		}
		if(sess.setRestriction == "" || Cards[c].set == sess.setRestriction)
			localCollection[Cards[c].rarity][c] = collection[c];
	}
	
	// Making sure we have enough cards of each rarity
	const count_cards = function(coll) { return Object.values(coll).reduce((acc, val) => acc + val, 0); };

	let comm_count = count_cards(localCollection['common']);
	if(comm_count < 10 * boosterQuantity) {
		emitMessage(sessionID, 'Error generating boosters', `Not enough cards (${comm_count}/${10 * boosterQuantity} commons) in collection.`);
		log(`Not enough cards (${comm_count}/${10 * boosterQuantity} commons) in collection.`, FgYellow);
		return false;
	}
	
	let unco_count = count_cards(localCollection['uncommon']);
	if(unco_count < 3 * boosterQuantity) {
		emitMessage(sessionID, 'Error generating boosters', `Not enough cards (${unco_count}/${3 * boosterQuantity} uncommons) in collection.`);
		log(`Not enough cards (${unco_count}/${3 * boosterQuantity} uncommons) in collection.`, FgYellow);
		return false;
	}
	
	let rm_count = count_cards(localCollection['rare']) + count_cards(localCollection['mythic']);
	if(rm_count < boosterQuantity) {
		emitMessage(sessionID, 'Error generating boosters', `Not enough cards (${rm_count}/${boosterQuantity} rares & mythics) in collection.`);
		log(`Not enough cards (${rm_count}/${boosterQuantity} rares & mythics) in collection.`, FgYellow);
		return false;
	}
	
	// TODO: Prevent multiples by name?
	
	let pick_card = function (dict, booster) {
		let c = get_random_key(dict);
		if(booster != undefined) {
			let prevention_attempts = 0; // Fail safe-ish
			while(booster.indexOf(c) != -1 && prevention_attempts < Object.keys(dict).length) {
				c = get_random_key(dict);
				++prevention_attempts;
			}
		}
		dict[c] -= 1;
		if(dict[c] == 0)
			delete dict[c];
		return c;
	};
	
	// Generate Boosters
	Sessions[sessionID].boosters = [];
	for(let i = 0; i < boosterQuantity; ++i) {
		let booster = [];
		
		 // 1 Rare/Mythic
		if(isEmpty(localCollection['mythic']) && isEmpty(localCollection['rare'])) {
			alert("Not enough cards in collection.");
			return;
		} else if(isEmpty(localCollection['mythic'])) {
			booster.push(pick_card(localCollection['rare']));
		} else if(isEmpty(localCollection['rare'])) {
			booster.push(pick_card(localCollection['mythic']));
		} else {
			if(Math.random() * 8 < 1)
				booster.push(pick_card(localCollection['mythic']));
			else
				booster.push(pick_card(localCollection['rare']));
		}

		for(let i = 0; i < 3; ++i) // 3 Uncommons
			booster.push(pick_card(localCollection['uncommon'], booster));
		
		for(let i = 0; i < 10; ++i) // 10 Commons
			booster.push(pick_card(localCollection['common'], booster));

		Sessions[sessionID].boosters.push(booster);
	}
	
	return true;
}

function emitMessage(sessionID, title, text, showConfirmButton = true) {
	for(let user of Sessions[sessionID].users) {
		Connections[user].socket.emit('message', {title: title, text: text, showConfirmButton: showConfirmButton});
	}
}

function syncSessionOptions(userID) {
	let sessionID = Connections[userID].sessionID;
	Connections[userID].socket.emit('setRestriction', Sessions[sessionID].setRestriction);
	Connections[userID].socket.emit('boostersPerPlayer', Sessions[sessionID].boostersPerPlayer);
	Connections[userID].socket.emit('bots', Sessions[sessionID].bots);
	Connections[userID].socket.emit('isPublic', Sessions[sessionID].isPublic);
}

function startDraft(sessionID) {
	let sess = Sessions[sessionID];
	sess.drafting = true;
	emitMessage(sessionID, 'Everybody is ready!', 'Your draft will start soon...');
	
	// boostersPerPlayer works fine, what's the problem here?...
	if(typeof sess.bots != "number") {
		sess.bots = parseInt(sess.bots);
	}
	
	let boosterQuantity = (sess.users.size + sess.bots) * sess.boostersPerPlayer;
	
	console.log("sess.users.size: " + sess.users.size);
	console.log("sess.bots: " + sess.bots);
	console.log("type: " + typeof sess.bots);
	console.log("type boostersPerPlayer: " + typeof sess.boostersPerPlayer);
	console.log("boosterQuantity: " + boosterQuantity);
	
	if(!generateBoosters(sessionID, boosterQuantity)) {
		sess.drafting = false;
		return;
	}
	
	for(let user of Sessions[sessionID].users) {
		Connections[user].socket.emit('startDraft');
	}
	Sessions[sessionID].round = 0;
	nextBooster(sessionID);
}
/*
// Concept only :)
function Bot() {
	this.cards = [];
	this.pickedColors = {"W": 0, "U": 0, "R": 0, "B": 0, "G": 0};
	this.pick = function(booster) {
		let maxScore = 0;
		let bestPick = 0;
		for(let idx = 0; idx < booster.length; ++idx) {
			let c = booster[idx];
			// TODO: Rate cards
			let score = c.rating;
			for(let color of c.colors) {
				score += 0.2 * pickedColor[color];
			}
			if(score > maxScore) {
				maxScore = score;
				bestPick = c;
			}
		}
		for(let color of booster[bestPick].colors) {
			pickedColors[color] += 1;
		}
		return bestPick;
	}
}
*/
function nextBooster(sessionID) {
	const totalVirtualPlayers = Sessions[sessionID].users.size + Sessions[sessionID].bots;
	
	// Boosters are empty
	if(Sessions[sessionID].boosters[0].length == 0) {
		Sessions[sessionID].round = 0;
		// Remove empty boosters
		Sessions[sessionID].boosters.splice(0, totalVirtualPlayers);
	}
	
	// End draft if no more booster to distribute
	if(Sessions[sessionID].boosters.length == 0) {
		endDraft(sessionID);
		return;
	}
	
	let index = 0;
	for(let user of Sessions[sessionID].users) {
		const boosterIndex = (Sessions[sessionID].round + index) % totalVirtualPlayers;
		Connections[user].socket.emit('nextBooster', {boosterIndex: boosterIndex, booster: Sessions[sessionID].boosters[boosterIndex]});
		++index;
	}
	Sessions[sessionID].pickedCardsThisRound = 0; // Only counting cards picked by human players
	// Bots picks
	for(let i = index; i < totalVirtualPlayers; ++i) {
		const boosterIndex = (Sessions[sessionID].round + i) % totalVirtualPlayers;
		const booster = Sessions[sessionID].boosters[boosterIndex];
		// TODO: Picking at random 'cause we're lazy. Do better one day? :)
		const removedIdx = Math.floor(Math.random() * booster.length);
		Sessions[sessionID].boosters[boosterIndex].splice(removedIdx, 1);
	}
	++Sessions[sessionID].round;
}

function endDraft(sessionID) {
	Sessions[sessionID].drafting = false;
	for(let user of Sessions[sessionID].users) {
		Connections[user].socket.emit('endDraft');
	}
	console.log(`Session ${sessionID} draft ended.`);
}

// Serve files in the public directory
app.use(express.static(__dirname + '/public/'));

///////////////////////////////////////////////////////////////////////////////
// Endpoints
// (TODO: Should be cleaned up)

app.get('/getCollection', (req, res) => {
	if(!req.cookies.sessionID)
		res.sendStatus(400);
	else
		res.send(Sessions[req.cookies.sessionID].collection());
});

app.get('/getCollection/:id', (req, res) => {
	if(!req.params.id) {
		res.sendStatus(400);
	} else {
		res.send(Sessions[req.params.id].collection());
	}
});

app.get('/getUsers/:sessionID', (req, res) => {
	res.send(JSON.stringify([...Sessions[req.params.sessionID].users]));
	res.sendStatus(200);
});

const secretKey = "b5d62b91-5f52-4512-b7fc-25626b9be37d";

var express_json_cache = []; // Clear this before calling
app.set('json replacer', function(key, value) {
	// Deal with sets
	if (typeof value === 'object' && value instanceof Set) {
		return [...value];
	}
	// Deal with circular references
	if (typeof value === 'object' && value !== null) {
		if (express_json_cache.indexOf(value) !== -1) {
			// Circular reference found, discard key
			return;
		}
		// Store value in our collection
		express_json_cache.push(value);
	}
	return value;
});

function returnJSON(res, data) {
	express_json_cache = [];
	res.json(data);
	express_json_cache = null; // Enable garbage collection
}

app.get('/getSessions/:key', (req, res) => {
	if(req.params.key ===  secretKey) {
		returnJSON(res, Sessions);
	} else {
		res.sendStatus(401).end();
	}
});

app.get('/getConnections/:key', (req, res) => {
	if(req.params.key ===  secretKey) {
		returnJSON(res, Connections);
	} else {
		res.sendStatus(401).end();
	}
});

http.listen(port, (err) => { 
	if(err) 
		throw err; 
	console.log('listening on port ' + port); 
}); 

///////////////////////////////////////////////////////////////////////////////

function getUserID(req, res) {
	if(!req.cookies.userID) {
		let ID = uuidv1();
		res.cookie("userID", ID);
		return ID;
	} else {
		return req.cookies.userID;
	}
}

// Remove user from previous session and cleanup if empty
function removeUserFromSession(userID, sessionID) {
	if(sessionID in Sessions) {
		if(Sessions[sessionID].drafting) {
			// Clients should stop drafting automatically
			Sessions[sessionID].drafting = false;
		}
		
		Sessions[sessionID].users.delete(userID);
		Connections[userID].sessionID = undefined;
		if(Sessions[sessionID].users.size == 0)
			delete Sessions[sessionID];
		else
			notifyUserChange(sessionID);
	}
}

function addUserToSession(userID, sessionID) {
	if(sessionID in Sessions) {
		Sessions[sessionID].users.add(userID)
	} else {
		Sessions[sessionID] = new Session(sessionID);
		Sessions[sessionID].users.add(userID);
	}
	Connections[userID].sessionID = sessionID;
	syncSessionOptions(userID);
	notifyUserChange(sessionID);
}

function notifyUserChange(sessionID) {
	// Send only necessary data
	let user_info = [];
	for(let user of Sessions[sessionID].users) {
		let u = Connections[user];
		user_info.push({
			userID: u.userID, 
			userName: u.userName,
			collection: u.collection,
			readyToDraft: u.readyToDraft
		});
	}
	
	// Send to all session users
	for(let user of Sessions[sessionID].users) {
		Connections[user].socket.emit('sessionUsers', user_info);
	}
}

// Log helper

function log(text, color = Reset) {
	console.log(color + text + '\x1b[0m');
}

const Reset = "\x1b[0m"
const Bright = "\x1b[1m"
const Dim = "\x1b[2m"
const Underscore = "\x1b[4m"
const Blink = "\x1b[5m"
const Reverse = "\x1b[7m"
const Hidden = "\x1b[8m"

const FgBlack = "\x1b[30m"
const FgRed = "\x1b[31m"
const FgGreen = "\x1b[32m"
const FgYellow = "\x1b[33m"
const FgBlue = "\x1b[34m"
const FgMagenta = "\x1b[35m"
const FgCyan = "\x1b[36m"
const FgWhite = "\x1b[37m"

const BgBlack = "\x1b[40m"
const BgRed = "\x1b[41m"
const BgGreen = "\x1b[42m"
const BgYellow = "\x1b[43m"
const BgBlue = "\x1b[44m"
const BgMagenta = "\x1b[45m"
const BgCyan = "\x1b[46m"
const BgWhite = "\x1b[47m"
