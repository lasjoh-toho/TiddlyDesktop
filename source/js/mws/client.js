/*
HTTP client for the MultiWikiServer (MWS) API, including OPAQUE login

Sessions are stored in <dataPath>/mws-sessions.json, readable only by the current user.
Passwords are never stored.
*/

"use strict";

var fs = require("fs"),
	http = require("http"),
	https = require("https"),
	path = require("path");

/*
Make a request
options.method, options.body (JSON serialised), options.session (session id)
Returns a promise for {status, text, json}
*/
function request(baseUrl,pathname,options) {
	options = options || {};
	var url = new URL(pathname.replace(/^\//,""),baseUrl.replace(/\/?$/,"/")),
		lib = url.protocol === "https:" ? https : http,
		body = options.body === undefined ? null : JSON.stringify(options.body),
		headers = {
			"Accept": "application/json",
			"X-Requested-With": "TiddlyWiki"
		};
	if(body !== null) {
		headers["Content-Type"] = "application/json";
		headers["Content-Length"] = Buffer.byteLength(body);
	}
	if(options.session) {
		headers.Cookie = "session=" + options.session;
	}
	return new Promise(function(resolve,reject) {
		var req = lib.request(url,{method: options.method || "GET", headers: headers, timeout: 60000},function(res) {
			var chunks = [];
			res.on("data",function(chunk) {chunks.push(chunk);});
			res.on("end",function() {
				var text = Buffer.concat(chunks).toString("utf8"),
					json;
				try {
					json = text ? JSON.parse(text) : undefined;
				} catch(e) {}
				resolve({status: res.statusCode, text: text, json: json});
			});
			res.on("error",reject);
		});
		req.on("timeout",function() {
			req.destroy(new Error("Request to " + url + " timed out"));
		});
		req.on("error",reject);
		req.end(body);
	});
}

// Make a request and return the parsed JSON, throwing on errors
function requestJson(baseUrl,pathname,options) {
	return request(baseUrl,pathname,options).then(function(res) {
		if(res.status === 401 || res.status === 403) {
			var err = new Error("Access denied (" + res.status + "). Log in with a user that has access to this wiki.");
			err.status = res.status;
			throw err;
		}
		if(res.status < 200 || res.status >= 300) {
			var error = new Error("Server responded with " + res.status + ": " + res.text.slice(0,300));
			error.status = res.status;
			throw error;
		}
		return res.json;
	});
}

/*
Load the OPAQUE client library: bundled with TiddlyDesktop, or from a local MWS installation
*/
function loadOpaque(extraPaths) {
	var candidates = ["@serenity-kit/opaque"].concat((extraPaths || []).map(function(p) {
		return path.join(p,"node_modules","@serenity-kit","opaque");
	}));
	for(var i = 0; i < candidates.length; i++) {
		try {
			return require(candidates[i]);
		} catch(e) {}
	}
	throw new Error("The OPAQUE login library is not available. Install a local MWS server first, or use a TiddlyDesktop build that includes it.");
}

/*
Log in and return {session, userId}
*/
function login(baseUrl,username,password,opaquePaths) {
	var opaque, clientLoginState;
	return Promise.resolve().then(function() {
		opaque = loadOpaque(opaquePaths);
		return opaque.ready;
	}).then(function() {
		var start = opaque.client.startLogin({password: password});
		clientLoginState = start.clientLoginState;
		return request(baseUrl,"/login/1",{method: "POST", body: {username: username, startLoginRequest: start.startLoginRequest}});
	}).then(function(res) {
		if(res.status !== 200 || !res.json) {
			throw new Error("Login failed: unknown user or server error (" + res.status + ")");
		}
		var finish = opaque.client.finishLogin({clientLoginState: clientLoginState, loginResponse: res.json.loginResponse, password: password});
		if(!finish) {
			throw new Error("Login failed: wrong password");
		}
		return request(baseUrl,"/login/2",{method: "POST", body: {finishLoginRequest: finish.finishLoginRequest, loginSession: res.json.loginSession, skipCookie: true}});
	}).then(function(res) {
		if(res.status !== 200 || !res.json || !res.json.session_id) {
			throw new Error("Login failed (" + res.status + ")");
		}
		return {session: res.json.session_id, userId: res.json.user_id};
	});
}

/*
Session storage
*/
function SessionStore(dataPath) {
	this.filename = path.resolve(dataPath,"mws-sessions.json");
}

SessionStore.prototype.readAll = function() {
	try {
		return JSON.parse(fs.readFileSync(this.filename,"utf8")) || {};
	} catch(e) {
		return {};
	}
};

SessionStore.prototype.get = function(serverId) {
	return this.readAll()[serverId] || null;
};

SessionStore.prototype.set = function(serverId,value) {
	var all = this.readAll();
	if(value) {
		all[serverId] = value;
	} else {
		delete all[serverId];
	}
	fs.mkdirSync(path.dirname(this.filename),{recursive: true});
	fs.writeFileSync(this.filename,JSON.stringify(all,null,2),{mode: 0o600});
	try {
		fs.chmodSync(this.filename,0o600);
	} catch(e) {}
};

exports.request = request;
exports.requestJson = requestJson;
exports.login = login;
exports.SessionStore = SessionStore;
