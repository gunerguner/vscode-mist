'use strict';

import * as convertor from './convertor';
import { MistContentProvider, getMistUri, isMistFile } from './previewProvider';
import MistNodeTreeProvider from './nodeTreeProvider';
import MistCompletionProvider from './completionProvider'
import MistDiagnosticProvider from './diagnosticProvider'
import { format } from './formatter'
import * as color from './utils/color'
import MistServer from './mistServer'

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, commands, Disposable, ExtensionContext, TextEditor, TextEditorEdit } from 'vscode';
import * as httpServer from 'http-server';

export function activate(context: ExtensionContext) {
    let server: MistServer = new MistServer(context);
    context.subscriptions.push(server);
    
    registerConvertor(context);
    registerMistServer(context);
    registerShowData(context);
    registerPreviewProvider(context, server);
    registerNodeTreeProvider(context);
    registerCompletionProvider(context);
    registerDiagnosticProvider(context, server);
    registerFormatter(context);
    registerColorDecorations(context);
}

let stopServerFunc;
export function deactivate(context: ExtensionContext) {
    if (stopServerFunc) {
        return stopServerFunc();
    }
}

function registerMistServer(context: ExtensionContext) {
    let server;
    let output;
    vscode.workspace.getConfiguration().update('mist.isDebugging', false);

    context.subscriptions.push(commands.registerCommand('mist.startServer', uri => {
        if (server) {
            return;
        }
        
        let workingDir = vscode.workspace.rootPath;
        if (!workingDir) {
            vscode.window.showErrorMessage("未打开文件夹");
            return;
        }

        let options = {
            root: workingDir,
            logFn: (req, res, err) => {
                output.appendLine(`> GET\t${req.url}`)
            }
        };

        let serverPort = 10001;
        server = httpServer.createServer(options);

        server.server.once("error", err => {
            server = null;
            let errMsg;
            if (err.code === 'EADDRINUSE') {
                errMsg = "Port 10001 already in use. Use <lsof -i tcp:10001> then <kill $PID> to free.";
            }
            else {
                errMsg = "Failed to start server. " + err.message;
            }
            vscode.window.showErrorMessage(errMsg);
        });

        server.listen(serverPort, "0.0.0.0", function () {
            vscode.workspace.getConfiguration().update('mist.isDebugging', true);

            output = vscode.window.createOutputChannel("Mist Debug Server");
            output.show();
            output.appendLine(`> Start mist debug server at 127.0.0.1:${serverPort}`);
        });
    }));

    context.subscriptions.push(commands.registerCommand('mist.stopServer', uri => {
        stopServer();
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        let validFormat = isMistFile(document) || document.uri.path.endsWith('.json');
        if (!validFormat || !server) {
            return;
        }

        let clientPort = 10002;
        let options = {
            hostname: '0.0.0.0',
            port: clientPort,
            method: 'GET',
            path: '/refresh'
        };

        var req = require('http').request(options, null);
        req.on('error', (e) => {
            console.log(`SIMULATOR NOT RESPONSE: ${e.message}\n`);
        });
        req.end();
    }));

    function stopServer() {
        if (server) {
            server.close();
            server = null;
        }
        
        if (output) {
            output.clear();
            output.hide();
            output.dispose();
            output = null;
        }

        if (vscode.workspace.rootPath) {
            // return vscode.workspace.getConfiguration().update('mist.isDebugging', false);

            // direct read/write the settings file cause update configuration dose not work in `deactivate`
            let settingsPath = `${vscode.workspace.rootPath}/.vscode/settings.json`;
            let text = fs.readFileSync(settingsPath).toString();
            let settings = JSON.parse(text);
            if (settings && settings["mist.isDebugging"]) {
                settings["mist.isDebugging"] = false;
                fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
            }
        }
    }

    stopServerFunc = stopServer;
}

function registerPreviewProvider(context: ExtensionContext, server: MistServer) {
    const contentProvider = new MistContentProvider(context, server);
    const contentProviderRegistration = vscode.workspace.registerTextDocumentContentProvider('mist', contentProvider);
    context.subscriptions.push(contentProviderRegistration);

    context.subscriptions.push(commands.registerCommand('mist.showPreviewToSide', uri => {
        let resource = uri;
        if (!(resource instanceof vscode.Uri)) {
            if (vscode.window.activeTextEditor) {
                // we are relaxed and don't check for markdown files
                resource = vscode.window.activeTextEditor.document.uri;
            }
        }

        return vscode.commands.executeCommand('vscode.previewHtml',
            getMistUri(uri),
            vscode.ViewColumn.Two,
            `Preview '${path.basename(resource.fsPath)}'`)
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (isMistFile(document)) {
            const uri = getMistUri(document.uri);
            contentProvider.update(uri);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (isMistFile(event.document)) {
            const uri = getMistUri(event.document.uri);
            contentProvider.update(uri);
        }
    }));
}

function registerConvertor(context: ExtensionContext) {
    context.subscriptions.push(commands.registerTextEditorCommand('mist.convertToNew', (textEditor: TextEditor, edit: TextEditorEdit) => {
        try {
            let isHomePage = path.basename(textEditor.document.fileName).startsWith('home_');
            let [newText, error, todoCount] = convertor.convertToNewFormat(textEditor.document.getText(), isHomePage);
            if (error) {
                vscode.window.showErrorMessage(error);
            }
            else {
                textEditor.edit(edit => edit.replace(new vscode.Range(textEditor.document.positionAt(0), textEditor.document.positionAt(textEditor.document.getText().length)), newText)).then(success => {
                    if (todoCount > 0) {
                        vscode.window.showInformationMessage("有 " + todoCount + " 个需要检查的地方");
                        let todoMark = "// TODO";
                        let index = textEditor.document.getText().indexOf(todoMark);
                        textEditor.selection = new vscode.Selection(textEditor.document.positionAt(index), textEditor.document.positionAt(index + todoMark.length));
                        textEditor.revealRange(textEditor.selection);
                        vscode.commands.executeCommand("actions.find");
                    }
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(error);
        }
    }));

    context.subscriptions.push(commands.registerCommand('mist.convertAll', args => {
        if (!vscode.workspace.rootPath) {
            vscode.window.showErrorMessage("未打开文件夹");
            return;
        }

        vscode.window.showInformationMessage("该操作可能会修改当前目录下的所有 .mist 文件，且无法撤销，确定要继续吗？", "确定").then(result => {
            if (result == "确定") {
                vscode.workspace.findFiles("*.mist").then(files => {
                    if (files.length == 0) {
                        vscode.window.showWarningMessage("没有找到 .mist 模版文件");
                        return;
                    }

                    let allTodoCount = 0;
                    let successCount = 0;
                    let failedCount = 0;
                    files.forEach(uri => {
                        let filePath = uri.fsPath;
                        let text = fs.readFileSync(filePath, "utf-8");
                        try {
                            let fileName = path.basename(filePath);
                            let [newText, error, todoCount] = convertor.convertToNewFormat(text, fileName.startsWith("home_"));
                            allTodoCount += todoCount;
                            if (error) {
                                throw error;
                            }
                            else {
                                fs.writeFileSync(filePath, newText, { encoding: "utf-8" });
                                console.log('"' + filePath + '" 转换成功');
                                successCount++;
                            }
                        } catch (error) {
                            console.error('"' + filePath + '" 转换失败，' + error);
                            failedCount++;
                        }
                    });

                    let info = "转换完成，其中 " + successCount + " 个成功，" + failedCount + " 个失败" + (allTodoCount > 0 ? "，共有 " + allTodoCount + " 个需要检查的地方，已用 '// TODO' 标记" : "");
                    vscode.window.showInformationMessage(info);
                });
            }
        });
    }));
}

function registerShowData(context: ExtensionContext) {
    context.subscriptions.push(commands.registerCommand('mist.showData', args => {
        let file = vscode.window.activeTextEditor.document.uri.fsPath;
        let dir = path.dirname(file);
        let templateId = path.basename(file, ".mist");
        fs.readdir(dir, (err, files) => {
            if (err) {
                vscode.window.showErrorMessage(err.message);
                return;
            }
            let result = [];
            files.filter(f => f.endsWith(".json")).map(f => {
                let file = `${dir}/${f}`;
                let text = fs.readFileSync(file).toString();
                if (text) {
                    let re = new RegExp(`"(block|template)\\w*"\\s*:\\s*"(\\w*?@)?${templateId}"`, "mg");
                    let match;
                    while (match = re.exec(text)) {
                        result.push({file: f, position: match.index});
                    }
                }
            });

            function showDataFile(info) {
                vscode.workspace.openTextDocument(`${dir}/${info.file}`).then(doc => 
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Two)).then(editor => {
                        editor.selection = new vscode.Selection(editor.document.positionAt(info.position), editor.document.positionAt(info.position));
                        editor.revealRange(editor.selection);
                    });
            }

            if (result.length == 0) {
                vscode.window.showInformationMessage('No data file found');
            }
            else if (result.length == 1) {
                showDataFile(result[0]);
            }
            else {
                vscode.window.showQuickPick(result.map(r => <vscode.QuickPickItem>{label: r.file, detail: ''+r.position})).then(r => {
                    showDataFile({file: r.label, position: Number.parseInt(r.detail)});
                });
            }
        });
    }));
}

function registerNodeTreeProvider(context: ExtensionContext) {
    const nodeTreeProvider = new MistNodeTreeProvider(context);
    const symbolsProviderRegistration = vscode.languages.registerDocumentSymbolProvider({ language: 'mist' }, nodeTreeProvider);
    vscode.window.registerTreeDataProvider('mistNodeTree', nodeTreeProvider);

    vscode.commands.registerCommand('mist.openNodeSelection', range => {
        nodeTreeProvider.select(range);
    });

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'mist') {
            nodeTreeProvider.update();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'mist') {
            nodeTreeProvider.update();
        }
    }));

}

function registerCompletionProvider(context: ExtensionContext) {
    let completionProvider = new MistCompletionProvider();
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'mist' }, completionProvider));
    context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'mist' }, completionProvider));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor.document.languageId === 'mist') {
            completionProvider.selectionDidChange(event.textEditor);
        }
    }));
}

function registerDiagnosticProvider(context: ExtensionContext, server: MistServer) {
    let diagnosticProvider = new MistDiagnosticProvider(context, server);
    context.subscriptions.push(diagnosticProvider);

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'mist') {
            diagnosticProvider.onChange(event.document);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId === 'mist') {
            diagnosticProvider.onChange(document);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'mist') {
            diagnosticProvider.onChange(document);
        }
    }));

}

function registerFormatter(context: ExtensionContext) {
    function _format(textEditor: vscode.TextEditor, selection: boolean) {
        let edits = format(textEditor.document, selection ? textEditor.selection : null, {
            tabSize: <number>textEditor.options.tabSize,
            insertSpaces: <boolean>textEditor.options.insertSpaces
        });
        textEditor.edit(edit => edits.forEach(e => edit.replace(e.range, e.newText)));
    }

    context.subscriptions.push(commands.registerTextEditorCommand('mist.format', (textEditor: TextEditor, edit: TextEditorEdit) => {
        _format(textEditor, false);
    }));

    context.subscriptions.push(commands.registerTextEditorCommand('mist.formatSelection', (textEditor: TextEditor, edit: TextEditorEdit) => {
        _format(textEditor, true);
    }));
}

function registerColorDecorations(context: ExtensionContext) {
    let decorationType = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: ' ',
            border: 'solid 0.1em #000',
            margin: '0.1em 0.2em 0 0.2em',
            width: '0.8em',
            height: '0.8em',
            
        },
        dark: {
            before: {
                border: 'solid 0.1em #eee'
            }
        }
    });
    context.subscriptions.push(decorationType);

    function _updateColorDecorations(document: vscode.TextDocument) {
        if (!document) {
            return;
        }

        let textEditor = vscode.window.visibleTextEditors.find(e => e.document == document);
        if (!textEditor) {
            return;
        }

        if (document.languageId !== 'mist') {
            textEditor.setDecorations(decorationType, []);
            return;
        }

        let colorResults = []
        let text = document.getText();
        let colorRE = /#((([a-fA-F0-9]{2}){3,4})|([a-fA-F0-9]{3,4}))\b/mg;
        let match;
        while (match = colorRE.exec(text)) {
            colorResults.push({color: match[0], offset:match.index});
        }

        textEditor.setDecorations(decorationType, []);
        textEditor.setDecorations(decorationType, colorResults.map(c => {
            let position = document.positionAt(c.offset);
            let cl = color.cssColor(c.color);

            return <vscode.DecorationOptions> {
                range: new vscode.Range(position, position),
                renderOptions: {
                    before: {
                        backgroundColor: cl
                    }
                }
            }
        }));
    }
    
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        _updateColorDecorations(event.document);
    }));
    
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        _updateColorDecorations(document);
    }));

	vscode.window.onDidChangeVisibleTextEditors(editors => {
		for (let editor of editors) {
			_updateColorDecorations(editor.document);
		}
    }, null, [decorationType]);

    function updateAllEditors() {
        vscode.window.visibleTextEditors.forEach(editor => {
            if (editor.document) {
                _updateColorDecorations(editor.document);
            }
        });
    }

    updateAllEditors();
}
