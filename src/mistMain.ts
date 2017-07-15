'use strict';

import * as convertor from './convertor';
import { MistContentProvider, getMistUri, isMistFile } from './previewProvider';
import MistNodeTreeProvider from './nodeTreeProvider';
import MistCompletionProvider from './completionProvider'
import MistDiagnosticProvider from './diagnosticProvider'
import { format } from './formatter'

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, commands, Disposable, ExtensionContext, TextEditor, TextEditorEdit } from 'vscode'

export function activate(context: ExtensionContext) {
    registerConvertor(context);
    registerPreviewProvider(context);
    registerNodeTreeProvider(context);
    registerCompletionProvider(context);
    registerDiagnosticProvider(context);
    registerFormatter(context);
}

function registerPreviewProvider(context: ExtensionContext) {
    const contentProvider = new MistContentProvider(context);
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
                textEditor.edit(edit=>edit.replace(new vscode.Range(textEditor.document.positionAt(0), textEditor.document.positionAt(textEditor.document.getText().length)), newText)).then(success=>{
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
                                fs.writeFileSync(filePath, newText, {encoding: "utf-8"});
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
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor.document.languageId === 'mist') {
			completionProvider.selectionDidChange(event.textEditor);
		}
    }));
}

function registerDiagnosticProvider(context: ExtensionContext) {
    let diagnosticProvider = new MistDiagnosticProvider();
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
