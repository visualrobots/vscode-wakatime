// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import vscode = require('vscode');

import fs = require('fs');
import os = require('os');
import path = require('path');
import child_process = require('child_process');

var AdmZip = require('adm-zip');
var ini = require('ini');
var request = require('request');
var rimraf = require('rimraf');


// this method is called when your extension is activated. activation is
// controlled by the activation events defined in package.json
export function activate(ctx: vscode.ExtensionContext) {

    // initialize WakaTime
    let wakatime = new WakaTime();

    // add to a list of disposables which are disposed when this extension
    // is deactivated again.
    ctx.subscriptions.push(wakatime);
}


export class WakaTime {

    private extension = vscode.extensions.getExtension("WakaTime.vscode-wakatime").packageJSON;
    private statusBar:vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    private disposable:vscode.Disposable;
    private lastFile:string;
    private lastHeartbeat:number = 0;
    private dependencies:Dependencies;
    private options:Options = new Options();

    constructor() {
        console.log('Initializing WakaTime v' + this.extension.version);
        this.statusBar.text = '$(clock) WakaTime Initializing...';
        this.statusBar.show();
        
        this._checkApiKey();

        this.dependencies = new Dependencies();
        this.dependencies.checkAndInstall(function() {
            this.statusBar.text = '$(clock) WakaTime Initialized';
            this.statusBar.show();
        }.bind(this));

        this._setupEventListeners();
    }

    private _checkApiKey() {
        this.options.hasApiKey(function(hasApiKey) {
            if (!hasApiKey) {
                this.options.promptForApiKey(function(apiKey) {
                    this.options.setApiKey(apiKey);
                }.bind(this));
            }
        }.bind(this));
    }

    private _setupEventListeners() {
        // subscribe to selection change and editor activation events
        let subscriptions: vscode.Disposable[] = [];
        vscode.window.onDidChangeTextEditorSelection(this._onChange, this, subscriptions);
        vscode.window.onDidChangeActiveTextEditor(this._onChange, this, subscriptions);
        vscode.workspace.onDidSaveTextDocument(this._onSave, this, subscriptions);

        // create a combined disposable from both event subscriptions
        this.disposable = vscode.Disposable.from(...subscriptions);
    }

    private _onChange() {
        this._onEvent(false);
    }

    private _onSave() {
        this._onEvent(true);
    }

    private _onEvent(isWrite) {
        let editor = vscode.window.activeTextEditor;
        if (editor) {
            let doc = editor.document;
            if (doc) {
                let file = doc.fileName;
                if (file) {
                    let time = Date.now();
                    if (isWrite || this._enoughTimePassed(time) || this.lastFile !== file) {
                        this._sendHeartbeat(file, isWrite);
                        this.lastFile = file;
                        this.lastHeartbeat = time;
                    }
                }
            }
        }
    }

    private _sendHeartbeat(file, isWrite) {
        this.dependencies.getPythonLocation(function(pythonBinary) {
            
            if (pythonBinary) {
        
                let core = this.dependencies.getCoreLocation();
                let user_agent = 'vscode/' + vscode.version + ' vscode-wakatime/' + this.extension.version;
                let args = [core, '--file', file, '--plugin', user_agent];
                let project = this._getProjectName();
                if (project)
                    args.push('--alternate-project', project);
                if (isWrite)
                    args.push('--write');
        
                let process = child_process.execFile(pythonBinary, args, function(error, stdout, stderr) {
                    if (error != null) {
                        if (stderr && stderr.toString() != '')
                            console.error(stderr);
                        if (stdout && stdout.toString() != '')
                            console.error(stdout);
                        console.log(error);
                    }
                }.bind(this));
                process.on('close', function(code, signal) {
                    if (code == 0) {
                        this.statusBar.text = '$(clock) WakaTime Active';
                        let today = new Date();
                        this.statusBar.tooltip = 'Last heartbeat sent at ' + this.formatDate(today);
                    } else if (code == 102) {
                        this.statusBar.text = '$(clock) WakaTime Offline, coding activity will sync when online.';
                        console.warn('API Error (102); Check your ~/.wakatime.log file for more details.');
                    } else if (code == 103) {
                        this.statusBar.text = '$(clock) WakaTime Error';
                        let error_msg = 'Config Parsing Error (103); Check your ~/.wakatime.log file for more details.';
                        this.statusBar.tooltip = error_msg;
                        console.error(error_msg);
                    } else if (code == 104) {
                        this.statusBar.text = '$(clock) WakaTime Error';
                        let error_msg = 'Invalid API Key (104); Make sure your API Key is correct!';
                        this.statusBar.tooltip = error_msg;
                        console.error(error_msg);
                    } else {
                        this.statusBar.text = '$(clock) WakaTime Error';
                        let error_msg = 'Unknown Error (' + code + '); Check your ~/.wakatime.log file for more details.';
                        this.statusBar.tooltip = error_msg;
                        console.error(error_msg);
                    }
                }.bind(this));
                
            }
            
        }.bind(this));
    }

    private formatDate(date) {
        let months = [
            'Jan',
            'Feb',
            'Mar',
            'Apr',
            'May',
            'Jun',
            'Jul',
            'Aug',
            'Sep',
            'Oct',
            'Nov',
            'Dec',
        ];
        let ampm = 'AM';
        let hour = date.getHours();
        if (hour > 11) {
            ampm = 'PM';
            hour = hour - 12;
        }
        if (hour == 0) {
            hour = 12;
        }
        let minute = date.getMinutes();
        if (minute < 10) minute = '0' + minute;
        return months[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear() + ' ' + hour + ':' + minute + ' ' + ampm;
    }

    private _enoughTimePassed(time) {
        return this.lastHeartbeat + 120000 < time;
    }

    private _getProjectName() {
        if (vscode.workspace && vscode.workspace.rootPath)
            try {
                return vscode.workspace.rootPath.match(/([^\/^\\]*)[\/\\]*$/)[1];
            } catch (e) {}
        return null;
    }

    public dispose() {
        this.statusBar.dispose();
        this.disposable.dispose();
    }
}


class Dependencies {

    private _cachedPythonLocation: string;

    public checkAndInstall(callback) {
        this.isPythonInstalled(function(isInstalled) {
            if (!isInstalled) {
                this.installPython(function() {
                    this.checkAndInstallCore(callback);
                }.bind(this));
            } else {
                this.checkAndInstallCore(callback);
            }
        }.bind(this));
    }

    public checkAndInstallCore(callback) {
        if (!this.isCoreInstalled()) {
            this.installCore(callback);
        } else {
            this.isCoreLatest(function(isLatest) {
                if (!isLatest) {
                    this.installCore(callback);
                } else {
                    callback();
                }
            }.bind(this));
        }
    }

    public getPythonLocation(callback) {
        if (this._cachedPythonLocation)
            return callback(this._cachedPythonLocation);

        let locations = [
            __dirname + path.sep + 'python' + path.sep + 'pythonw',
            "pythonw",
            "python",
            "/usr/local/bin/python",
            "/usr/bin/python",
        ];
        for (var i=40; i>=26; i--) {
          locations.push('\\python' + i + '\\pythonw');
          locations.push('\\Python' + i + '\\pythonw');
        }
    
        let args = ['--version'];
        for (var i = 0; i < locations.length; i++) {
            try {
                let stdout = child_process.execFileSync(locations[i], args);
                this._cachedPythonLocation = locations[i];
                return callback(locations[i]);
            } catch (e) { }
        }
            
        callback(null);

    }

    public getCoreLocation() {
        let dir = __dirname + path.sep + 'wakatime-master' + path.sep + 'wakatime' + path.sep + 'cli.py';
        return dir;
    }

    private isCoreInstalled() {
        return fs.existsSync(this.getCoreLocation());
    }

    private isCoreLatest(callback) {
        this.getPythonLocation(function(pythonBinary) {
            if (pythonBinary) {
    
                let args = [this.getCoreLocation(), '--version'];
                child_process.execFile(pythonBinary, args, function(error, stdout, stderr) {
                    if (!(error != null)) {
                        let currentVersion = stderr.toString().trim();
                        console.log('Current wakatime-core version is ' + currentVersion);
    
                        console.log('Checking for updates to wakatime-core...');
                        this.getLatestCoreVersion(function(latestVersion) {
                            if (currentVersion === latestVersion) {
                                console.log('wakatime-core is up to date.');
                                if (callback)
                                    callback(true);
                            } else if (latestVersion) {
                                console.log('Found an updated wakatime-core v' + latestVersion);
                                if (callback)
                                    callback(false);
                            } else {
                                console.log('Unable to find latest wakatime-core version from GitHub.');
                                if (callback)
                                    callback(false);
                            }
                        });
                    } else {
                        if (callback)
                            callback(false);
                    }
                }.bind(this));
            } else {
                if (callback)
                    callback(false);
            }
        }.bind(this));
    }

    private getLatestCoreVersion(callback) {
        let url = 'https://raw.githubusercontent.com/wakatime/wakatime/master/wakatime/__about__.py';
        request.get(url, function(error, response, body) {
            let version = null;
            if (!error && response.statusCode == 200) {
                let lines = body.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    let re = /^__version_info__ = \('([0-9]+)', '([0-9]+)', '([0-9]+)'\)/g;
                    let match = re.exec(lines[i]);
                    if (match != null) {
                        version = match[1] + '.' + match[2] + '.' + match[3];
                        if (callback)
                          return callback(version);
                    }
                }
            }
            if (callback)
                return callback(version);
        });
    }

    private installCore = function(callback) {
        console.log('Downloading wakatime-core...');
        let url = 'https://github.com/wakatime/wakatime/archive/master.zip';
        let zipFile = __dirname + path.sep + 'wakatime-master.zip';

        this.downloadFile(url, zipFile, function() {
            this.extractCore(zipFile, callback);
        }.bind(this));
    }

    private extractCore(zipFile, callback) {
        console.log('Extracting wakatime-core into "' + __dirname + '"...');
        this.removeCore(() => {
            this.unzip(zipFile, __dirname, callback);
            console.log('Finished extracting wakatime-core.');
        });
    }

    private removeCore(callback) {
        if (fs.existsSync(__dirname + path.sep + 'wakatime-master')) {
            try {
                rimraf(__dirname + path.sep + 'wakatime-master', function() {
                    if (callback != null) {
                        return callback();
                    }
                });
            } catch (e) {
                console.warn(e);
            }
        } else {
            if (callback != null) {
                return callback();
            }
        }
    }

    private downloadFile(url, outputFile, callback) {
        let r = request(url);
        let out = fs.createWriteStream(outputFile);
        r.pipe(out);
        return r.on('end', function() {
            return out.on('finish', function() {
                if (callback != null) {
                    return callback();
                }
            });
        });
    }

    private unzip(file, outputDir, callback) {
        if (fs.existsSync(file)) {
            try {
                let zip = new AdmZip(file);
                zip.extractAllTo(outputDir, true);
            } catch (e) {
                return console.error(e);
            } finally {
                fs.unlink(file);
                if (callback != null) {
                    return callback();
                }
            }
        }
    }

    private isPythonInstalled(callback) {
        this.getPythonLocation(function(pythonBinary) {
            callback(!!pythonBinary);
        }.bind(this));
    }

    private installPython(callback) {
        if (os.type() === 'Windows_NT') {
            let ver = '3.5.1';
            let arch = 'win32';
            if (os.arch().indexOf('x64') > -1) arch = 'amd64';
            let url = 'https://www.python.org/ftp/python/' + ver + '/python-' + ver + '-embed-' + arch + '.zip';

            console.log('Downloading python...');
            let zipFile = __dirname + path.sep + 'python.zip';
            this.downloadFile(url, zipFile, function() {

                console.log('Extracting python...');
                this.unzip(zipFile, __dirname + path.sep + 'python');
                console.log('Finished installing python.');

                callback();

            }.bind(this));
        } else {
            console.error('WakaTime depends on Python. Install it from https://python.org/downloads then restart VSCode.');
            // window.alert('WakaTime depends on Python. Install it from https://python.org/downloads then restart VSCode.');
        }
    }
}


class Options {

    private _apiKey:string;

    public hasApiKey(callback) {
        this.getApiKey(function(error, apiKey) {
            callback(!error);
        });
    }

    public getApiKey(callback) {
        let file = path.join(this.getUserHomeDir(), '.wakatime.cfg');
        fs.readFile(file, 'utf-8', function(err, content) {
            if (err) {
                callback(new Error('could not read ~/.wakatime.cfg'), null);
            } else {
                let configs = ini.parse(content);
                if (configs && configs.settings && configs.settings.api_key) {
                    callback(null, configs.settings.api_key);
                } else {
                    callback(new Error('wakatime key not found'), null);
                }
            }
        });
    }

    public setApiKey(apiKey:string, callback?) {
        if (apiKey) {
            let file = path.join(this.getUserHomeDir(), '.wakatime.cfg');
            let content = '[settings]\napi_key = ' + apiKey;
            fs.writeFile(file, content, function(err) {
                if (err) {
                    if (callback)
                        callback(new Error('could not write to ~/.wakatime.cfg'));
                } else {
                    if (callback)
                        callback(null);
                }
            });
        }
    }

    public promptForApiKey(callback, defaultKey?:string) {
        let options = {prompt: 'WakaTime API Key', value: defaultKey};
        vscode.window.showInputBox(options).then(function(apiKey) {
            callback(apiKey);
        });
    }

    public getUserHomeDir() {
        return process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] || '';
    }
}
