/*\
title: $:/TiddlyDesktop/startup/mws.js
type: application/javascript
module-type: startup

Message handlers for managing MultiWikiServer (MWS) instances

\*/
"use strict";

// Export name and synchronous status
exports.name = "tiddlydesktop-mws";
exports.after = ["startup"];
exports.synchronous = true;

var FORM_TITLE = "$:/temp/TiddlyDesktop/MWS/Form";

exports.startup = function() {

	function mws() {
		return $tw.desktop.mws;
	}

	// Ask for confirmation in the window that sent the message
	function confirm(event,text) {
		var doc = event.widget && event.widget.document,
			win = (doc && doc.defaultView) || window;
		return win.confirm(text);
	}

	function report(promise) {
		if(promise && promise.catch) {
			promise.catch(function(err) {
				mws().alert((err && err.message) || String(err));
			});
		}
		return false;
	}

	function formFields(event) {
		var tiddler = $tw.wiki.getTiddler(event.param || FORM_TITLE);
		return tiddler ? $tw.utils.extend({},tiddler.fields) : {};
	}

	function closeForm(event) {
		$tw.wiki.deleteTiddler(event.param || FORM_TITLE);
	}

	var handlers = {
		// Store the folder chosen with a <$browse nwdirectory> widget in the field named by param (title!!field)
		"tm-mws-pick-folder": function(event) {
			var file = event.files && event.files[0],
				parts = (event.param || "").split("!!"),
				title = parts[0],
				field = parts[1] || "text";
			if(file && file.path && title) {
				var update = {title: title};
				update[field] = file.path;
				$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler(title),update));
			}
		},
		"tm-mws-check-environment": function(event) {
			return report(mws().checkEnvironment());
		},
		"tm-mws-refresh": function(event) {
			var m = mws();
			m.getServerIds().forEach(function(id) {
				m.refreshBackups(id);
			});
			return report(m.checkAll());
		},
		"tm-mws-install": function(event) {
			var fields = formFields(event);
			closeForm(event);
			return report(mws().install(fields));
		},
		"tm-mws-add-existing": function(event) {
			var fields = formFields(event);
			if(!fields.folder) {
				mws().alert("Choose the MWS data folder (the folder containing passwords.key and the store folder)");
				return;
			}
			if(mws().addExisting(fields.folder,fields)) {
				closeForm(event);
			}
		},
		"tm-mws-add-ssh": function(event) {
			var fields = formFields(event);
			if(fields.install === "yes") {
				closeForm(event);
				fields.kind = "ssh";
				return report(mws().install(fields));
			}
			if(mws().addSsh(fields)) {
				closeForm(event);
			}
		},
		"tm-mws-add-remote": function(event) {
			if(mws().addRemote(formFields(event))) {
				closeForm(event);
			}
		},
		"tm-mws-remove": function(event) {
			var server = mws().getServer(event.param);
			if(server && confirm(event,"Remove \"" + server.name + "\" from the list?\n\nThe data folder and the backups are not deleted.")) {
				return report(mws().remove(event.param));
			}
		},
		"tm-mws-start": function(event) {
			return report(mws().start(event.param));
		},
		"tm-mws-stop": function(event) {
			return report(mws().stop(event.param));
		},
		"tm-mws-restart": function(event) {
			return report(mws().restart(event.param));
		},
		"tm-mws-status": function(event) {
			return report(mws().checkStatus(event.param));
		},
		"tm-mws-open-admin": function(event) {
			mws().openAdmin(event.param,event.paramObject && event.paramObject.path);
		},
		"tm-mws-open-browser": function(event) {
			mws().openInBrowser(event.param);
		},
		"tm-mws-reveal": function(event) {
			mws().revealFolder(event.param);
		},
		"tm-mws-backup": function(event) {
			return report(mws().backup(event.param));
		},
		"tm-mws-reveal-backups": function(event) {
			mws().revealBackups(event.param);
		},
		"tm-mws-restore": function(event) {
			var id = event.param,
				name = event.paramObject && event.paramObject.backup,
				server = mws().getServer(id);
			if(server && name && confirm(event,"Restore \"" + server.name + "\" from " + name + "?\n\n" +
					"The server is stopped while restoring. All changes made after this backup are replaced; " +
					"the current store folder is kept as store.before-restore-<date> in the data folder.")) {
				return report(mws().restore(id,name));
			}
		},
		"tm-mws-restore-as-new": function(event) {
			var id = event.param,
				name = event.paramObject && event.paramObject.backup,
				form = $tw.wiki.getTiddler(event.paramObject && event.paramObject.form),
				parent = form && form.fields.parent,
				folder = form && form.fields.folder;
			if(!parent || !folder) {
				mws().alert("Choose a parent folder and enter a name for the new data folder");
				return;
			}
			$tw.wiki.deleteTiddler(form.fields.title);
			return report(mws().restoreAsNew(id,name,parent,folder));
		},
		"tm-mws-delete-backup": function(event) {
			var id = event.param,
				name = event.paramObject && event.paramObject.backup;
			if(name && confirm(event,"Delete the backup " + name + "? This cannot be undone.")) {
				mws().deleteBackup(id,name);
			}
		},
		"tm-mws-check-updates": function(event) {
			return report(mws().checkForUpdates(event.param));
		},
		"tm-mws-update-mws": function(event) {
			var server = mws().getServer(event.param);
			if(server && confirm(event,"Update MWS for \"" + server.name + "\"?\n\nThe server is stopped during the update" +
					(server.backupBeforeUpdate ? " and a backup is made first." : "."))) {
				return report(mws().updateMws(event.param));
			}
		},
		"tm-mws-update-tiddlywiki": function(event) {
			return report(mws().updateTiddlyWiki(event.param));
		},
		"tm-mws-repair": function(event) {
			return report(mws().repair(event.param));
		},
		"tm-mws-fetch-log": function(event) {
			return report(mws().fetchRemoteLog(event.param));
		},
		"tm-mws-clear-log": function(event) {
			mws().clearLog(event.param);
		}
	};

	$tw.utils.each(handlers,function(handler,name) {
		$tw.rootWidget.addEventListener(name,function(event) {
			if(!mws()) {
				return false;
			}
			handler(event);
			return false;
		});
	});
};
