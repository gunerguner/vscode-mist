import { Uri, TextDocument, TextDocumentChangeEvent, CompletionItem, Hover } from "vscode";
import * as vscode from "vscode";
import * as json from 'jsonc-parser'
import * as path from 'path'
import * as fs from 'fs'
import { parseJson, getPropertyNode, getNodeValue } from './utils/json'
import { ImageHelper } from "./imageHelper";
import { LexerErrorCode } from "./browser/lexer";
import { Type, IType, Method, Property, ArrayType, UnionType, ObjectType, IntersectionType, LiteralType, ArrowType } from "./browser/type";
import { ExpressionContext, None, ExpressionNode, IdentifierNode, ExpressionErrorLevel } from "./browser/parser";
import Snippets from "./snippets";
import { parse, parseExpressionInObject } from "./browser/template";
import { Schema, validateJsonNode, TypedNode } from "./schema";
import { templateSchema, NodeSchema, eventParamsMap } from "./template_schema";

enum ExpType {
    Void,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Function,
    Lambda,
    Other,
}

function nameOfType(type: ExpType) {
    switch (type) {
        case ExpType.Void: return "void";
        case ExpType.Object: return "object";
        case ExpType.Array: return "array";
        case ExpType.Number: return "number";
        case ExpType.String: return "string";
        case ExpType.Boolean: return "bool";
        case ExpType.Function: return "function";
        case ExpType.Lambda: return "lambda";
        default: return "<unknown>";
    }
}

let MIST_EXP_RE = /\$\{.*?\}/mg;
// let MIST_EXP_PREFIX_RE = /([_a-zA-Z0-9.]+)\.([_a-zA-Z][_a-zA-Z0-9]*)?$/;

const _DATA_DESC = `模板关联的完整数据。一般情况建议直接访问数据，仅当需要根据动态的 key 访问数据时才使用 _data_，例如 _data_['item_' + index]`

class Variable {
    name: string;
    type: IType;
    value: any;
    description: string;
    incomplete: boolean;
    node: json.Node;
    uri: vscode.Uri;

    static unique(vars: Variable[]) {
        let reversed = [...vars].reverse();
        return vars.filter((v, i) => reversed.findIndex(n => n.name === v.name) === vars.length - i - 1);
    }
    
    constructor(name: string, value: any, description?: string, incomplete: boolean = false) {
        this.name = name;
        let a = [[100, 18], [50, 20], [80, 14], [130, 23], [70, 17], [60, 26], [80, 19], [50, 21], [80, 23], [70, 18], [80, 20]];
        
        if (value instanceof IType) {
            this.type = value;
            this.value = None;
        }
        else {
            this.value = value;
        }
        this.description = description;
        this.incomplete = incomplete;
    }

    setNode(node: json.Node, uri: string = null) {
        this.node = node;
        this.uri = uri ? vscode.Uri.file(uri) : null;
        return this;
    }

}

function findLastIndex<T>(list: T[], predicate: (element: T) => boolean): number {
    for (var i = list.length - 1; i >= 0; i--) {
        if (predicate(list[i])) {
            return i;
        }
    }
    return -1;
}

let BUILTIN_VARS = [
    new Variable("_width_", Type.Number, "屏幕宽度"),
    new Variable("_height_", Type.Number, "屏幕高度"),
    new Variable("_mistitem_", Type.Any, "当前模板对应的 item 对象"),
    new Variable("_controller_", Type.getType('Controller'), "当前模板对应的 controller 对象"),
    new Variable("_platform_", new UnionType(new LiteralType('iOS'), new LiteralType('Android')), "当前运行平台"),
    new Variable("is_ios", Type.Boolean, "当前运行平台是否为 iOS"),
    new Variable("is_android", Type.Boolean, "当前运行平台是否为 Android"),
    new Variable("system", Type.registerType(new Type('system')).registerPropertys({
        "name": new Property(Type.String, "系统名称"),
        "version": new Property(Type.String, "系统版本"),
        "deviceName": new Property(Type.String, "设备名称")
    }), "系统信息（暂仅支持 iOS）"),
    new Variable("screen", Type.registerType(new Type('screen')).registerPropertys({
        "width": new Property(Type.Number, "屏幕宽度"),
        "height": new Property(Type.Number, "屏幕高度"),
        "scale": new Property(Type.Number, "屏幕像素密度"),
        "statusBarHeight": new Property(Type.Number, "状态栏高度"),
        "isPlus": new Property(Type.Boolean, "是否是大屏（iPhone 6/6s/7/8 Plus）"),
        "isSmall": new Property(Type.Boolean, "是否是小屏（iPhone 4/4s/5/5s/SE）"),
        "isX": new Property(Type.Boolean, "是否是 iPhone X"),
        "safeArea": new Property(Type.getType('UIEdgeInsets'), "安全区域"),
    }), "屏幕属性（暂仅支持 iOS）"),
    new Variable("app", Type.registerType(new Type('screen')).registerPropertys({
        "isAlipay": new Property(Type.Boolean, "是否是支付宝客户端"),
        "isKoubei": new Property(Type.Boolean, "是否是口碑客户端"),
    }), "应用属性（暂仅支持 iOS）"),
    new Variable("env", Type.registerType(new Type('env')).registerPropertys({
        "screenWidth": new Property(Type.Number, "屏幕宽度"),
        "screenHeight": new Property(Type.Number, "屏幕高度"),
        "layoutWidth": new Property(Type.Number, "布局约束宽度，可能为 NAN"),
        "layoutHeight": new Property(Type.Number, "布局约束高度，可能为 NAN"),
        "scale": new Property(Type.Number, "屏幕像素密度"),
        "statusBarHeight": new Property(Type.Number, "状态栏高度"),
        "titleBarHeight": new Property(Type.Number, "导航栏高度"),
        "systemVersion": new Property(Type.String, "系统版本"),
        "appVersion": new Property(Type.String, "应用版本"),
    }), "环境变量"),
];

export class JsonStringError {
    description: string;
    offset: number;
    length: number;
    constructor(description: string, offset: number, length: number) {
        this.description = description;
        this.offset = offset;
        this.length = length;
    }
}

export class JsonString {
    source: string;
    parsed: string;
    errors: JsonStringError[];
    escapes: {
        parsedIndex: number,
        sourceIndex: number,
        sourceEnd: number
    }[];

    constructor(source: string) {
        this.source = source;
        this.errors = [];
        this.parse();
    }

    sourceIndex(parsedIndex: number): number {
        if (this.escapes.length === 0) return parsedIndex;
        let i = this.escapes.findIndex(e => e.parsedIndex >= parsedIndex);
        if (i >= 0) return this.escapes[i].sourceIndex - this.escapes[i].parsedIndex + parsedIndex;

        let last = this.escapes[this.escapes.length - 1];
        return parsedIndex - last.parsedIndex - 1 + last.sourceEnd;
    }

    parsedIndex(sourceIndex: number): number {
        if (this.escapes.length === 0) return sourceIndex;
        let i = this.escapes.findIndex(e => e.sourceIndex >= sourceIndex);
        if (i >= 0) return this.escapes[i].parsedIndex - this.escapes[i].sourceIndex + sourceIndex;
        
        let last = this.escapes[this.escapes.length - 1];
        if (sourceIndex < last.sourceEnd) {
            return last.parsedIndex;
        }
        return sourceIndex - last.sourceEnd + last.parsedIndex + 1;
    }

    private parse() {
        let origin = this.source;
        let parsed = '';
        let start = 0;
        this.escapes = [];
        for (let i = 0; i < origin.length;) {
            let c = origin.charAt(i);
            if (c < ' ') {
                this.errors.push(new JsonStringError('Invalid characters in string. Control characters must be escaped.', i, 1));
                parsed += c;
                i++;
            }
            else if (c === '\\' && i < origin.length - 1) {
                if (i > start) parsed += origin.substring(start, i);
                c = origin.charAt(i + 1);
                let sourceIndex = i;
                let parsedIndex = parsed.length;
                switch (c) {
                    case '"': parsed += '"'; break;
                    case '\\': parsed += '\\'; break;
                    case '/': parsed += '/'; break;
                    case 'b': parsed += '\b'; break;
                    case 'f': parsed += '\f'; break;
                    case 'n': parsed += '\n'; break;
                    case 'r': parsed += '\r'; break;
                    case 't': parsed += '\t'; break;
                    case 'u':
                        let match = origin.substr(i + 2, 4).match(/^[0-9A-Fa-f]*/);
                        let hex = match[0];
                        if (hex.length !== 4) {
                            this.errors.push(new JsonStringError('Invalid unicode sequence in string', i, 2 + hex.length));
                        }
                        else {
                            parsed += String.fromCharCode(parseInt(hex, 16));
                        }
                        i += hex.length;
                        break;
                    default:
                        this.errors.push(new JsonStringError('Invalid escape character in string', i, 2));
                        break;
                }
                i += 2;
                start = i;
                this.escapes.push({
                    sourceIndex: sourceIndex,
                    sourceEnd: i,
                    parsedIndex: parsedIndex
                });
            }
            else {
                i++;
            }
        }
        if (origin.length > start) parsed += origin.substring(start);
        this.parsed = parsed;
    }
}

const MOCK_EXT = '.mock.json'

export class MistData {
    static dataMap: { [dir: string]: { [file: string]: MistData[] } } = {};
    
    template: string;
    file: string;
    data: any;
    node: json.Node;
    start: number;
    end: number;
    index: number;
    name: string

    static openFile(file: string) {
        if (file.endsWith(MOCK_EXT)) {
            this.openMockFile(file)
            return
        }

        // 解析业务数据，递归查找包含模板 key (template/templateId/blockId)和数据 key (data)的节点
        let dir = path.dirname(file);
        if (!(dir in this.dataMap)) {
            this.dataMap[dir] = {};
        }
        let text = fs.readFileSync(file).toString();
        if (text) {
            let jsonTree = parseJson(text);
            var results = [];
            let travelTree = (obj: json.Node) => {
                if (!obj) return

                if (obj.type === 'array') {
                    obj.children.forEach(travelTree);
                }
                else if (obj.type === 'object') {
                    let valueForKey = k => {
                        let node = obj.children.find(c => c.children[0].value === k);
                        return node ? node.children[1] : null;
                    }
                    let templateKeys = ["templateId", "template", "blockId"];
                    let dataNode, key;
                    if ((dataNode = valueForKey('data')) && (key = templateKeys.find(k => !!valueForKey(k)))) {
                        let data = new MistData();
                        let templateId: string = valueForKey(key).value;
                        if (typeof templateId !== 'string') {
                            return
                        }
                        templateId = templateId.replace(/^\w+@/, '');
                        data.template = templateId;
                        data.file = file;
                        data.start = obj.offset;
                        data.end = obj.offset + obj.length;
                        data.data = getNodeValue(dataNode);
                        data.node = dataNode;
                        results.push(data);
                    }
                    else {
                        obj.children.filter(c => c.children.length >= 2).map(c => c.children[1]).forEach(travelTree);
                    }
                }
            }
            travelTree(jsonTree);
            this.dataMap[dir][file] = results;
            Object.keys(MistDocument.documents).forEach(k => {
                const doc = MistDocument.documents[k]
                if (doc) {
                    doc.clearDatas()
                }
            });
        }
    }

    /**
     * 解析标准 mock 数据，格式如下
     * 
     * interface DataObj {
     *   mockData: any
     *   template?: string // 如果不指定，使用文件名
     *   name?: string
     * }
     * 
     * type Data = DataObj | any
     * type DataFile = Data | Data[]
     */
    static openMockFile(file: string) {
        let dir = path.dirname(file);
        if (!(dir in this.dataMap)) {
            this.dataMap[dir] = {};
        }
        let text = fs.readFileSync(file).toString();
        if (text) {
            const fileName = path.basename(file, MOCK_EXT)
            let jsonTree = parseJson(text);
            var results = [];
            let parseMockData = (obj: json.Node) => {
                if (!obj || obj.type !== 'object') return

                let valueForKey = k => {
                    let node = obj.children.find(c => c.children[0].value === k);
                    return node ? node.children[1] : null;
                }

                let data = new MistData();
                data.file = file;
                data.start = obj.offset;
                data.end = obj.offset + obj.length;

                const dataNode = valueForKey('mockData')
                if (dataNode) {
                    const nameNode = valueForKey('name')
                    if (nameNode) {
                        data.name = nameNode.value
                    }

                    const templateNode = valueForKey('template');
                    let templateId: string = templateNode ? templateNode.value : fileName;
                    if (typeof templateId !== 'string') {
                        return
                    }
                    templateId = templateId.replace(/^\w+@/, '');

                    data.template = templateId;
                    data.data = getNodeValue(dataNode);
                    data.node = dataNode;
                }
                else {
                    data.template = fileName;
                    data.data = getNodeValue(obj)
                    data.node = obj
                }
                results.push(data);
            }
            
            if (jsonTree.type === 'array') {
                jsonTree.children.forEach(node => parseMockData(node))
            }
            else {
                parseMockData(jsonTree)
            }

            this.dataMap[dir][file] = results;
            Object.keys(MistDocument.documents).forEach(k => {
                const doc = MistDocument.documents[k]
                if (doc) {
                    doc.clearDatas()
                }
            });
        }
    }

    static openDir(dir: string) {
        if (!(dir in this.dataMap)) {
            this.dataMap[dir] = {};
            let files = fs.readdirSync(dir);
            files.filter(f => f.endsWith(".json")).map(f => {
                let file = `${dir}/${f}`;
                this.openFile(file);
            });
        }
    }

    static getData(dir: string, template: string) {
        let dirDatas = this.dataMap[dir];
        let result = [];
        if (dirDatas) {
            for (let file in dirDatas) {
                let datas = dirDatas[file];
                let found = datas.filter(d => d.template === template);
                if (found && found.length > 0) {
                    if (found.length > 1) {
                        found.forEach((d, i) => d.index = i);
                    }
                    result = result.concat(found);
                }
            }
        }
        return result;
    }

    public description() {
        if (this.name) {
            return this.name
        }
        return `${path.basename(this.file)} ${this.index !== undefined ? `#${this.index + 1}` : ''}`.trim();
    }
}

class MistNode {
    node: json.Node;
    children: MistNode[];
    parent: MistNode;

    constructor(node: json.Node) {
        this.node = node;
        let children = getPropertyNode(node, 'children');
        if (children && children.type === 'array') {
            this.children = children.children.map(n => {
                let child = new MistNode(n);
                child.parent = this;
                return child;
            })
        }
    }

    property(key: string) {
        let p = getPropertyNode(this.node, key);
        return p ? getNodeValue(p) : null;
    }

    type() {
        var type = this.property('type');
        if (!type) {
            type = this.property('children') ? 'stack' : 'node';
        }
        else if (typeof(type) === 'string' && type.match(/^\${.+}$/)) {
            type = "exp";
        }
        return type;
    }
}

export function getCurrentExpression(exp: string) {
    var index = exp.length - 1;
    var stop = false;
    var braceCount = {};
    const braceDict = {'{': '}', '(': ')', '[': ']'};
    while (index >= 0) {
        var c = exp[index];
        switch (c) {
            case ',':
            case '?':
            case ':':
            case '+':
            case '-':
            case '*':
            case '/':
            case '%':
            case '&':
            case '|':
            case '!':
            case '>':
            case '<':
            case '=':
                if (Object.keys(braceCount).every(k => braceCount[k] === 0)) {
                    stop = true;
                }
                break;
            case '(':
            case '{':
            case '[':
                c = braceDict[c];
                braceCount[c] = (braceCount[c] || 0) - 1;
                if (braceCount[c] < 0) {
                    stop = true;
                }
                break;
            case '\'':
            case '"':
                let quote = c;
                while (--index >= 0) {
                    c = exp[index];
                    if (c === quote) {
                        break;
                    }
                }
                break;
            case ']':
            case ')':
            case '}':
                braceCount[c] = (braceCount[c] || 0) + 1;
        }
        if (stop) {
            break;
        }
        index--;
    }
    return exp.substr(index + 1).trim();
}

export function getPrefix(exp: string): {prefix: string, function: string} {
    let match = /(.*)\.([_a-zA-Z]\w*)?$/.exec(exp);
    let prefix;
    let func;
    if (match) {
        return {
            prefix: match[1],
            function: match[2]
        };
    }
    else {
        return {
            prefix: null,
            function: exp
        };
    }
}

// (1, xx(2, 3), 3) => 3
export function getFunctionParamsCount(exp: string) {
    var index = 1;
    var stop = false;
    var braceCount = {};
    var commaCount = 0;
    let braceDict = {'}': '{', ')': '(', ']': '['};
    while (index < exp.length) {
        var c = exp[index];
        switch (c) {
            case ',':
                if (Object.keys(braceCount).every(k => braceCount[k] === 0)) {
                    commaCount++;
                }
                break;
            case '(':
            case '{':
            case '[':
                braceCount[c] = (braceCount[c] || 0) + 1;
                break;
            case '\'':
            case '"':
                let quote = c;
                while (++index < exp.length) {
                    c = exp[index];
                    if (c === quote) {
                        break;
                    }
                }
                break;
            case ']':
            case ')':
            case '}':
                c = braceDict[c];
                braceCount[c] = (braceCount[c] || 0) - 1;
                if (braceCount[c] < 0) {
                    stop = true;
                }
        }
        if (stop) {
            break;
        }
        index++;
    }

    let paramsCount = commaCount + 1;
    if (exp.substring(1, index).match(/^\s*$/)) {
        paramsCount = 0;
    }
    
    return paramsCount;
}

export function getSignatureInfo(exp: string) {
    var index = exp.length - 1;
    var stop = false;
    var braceCount = {};
    var commaCount = 0;
    let braceDict = {'{': '}', '(': ')', '[': ']'};
    while (index >= 0) {
        var c = exp[index];
        switch (c) {
            case ',':
                if (Object.keys(braceCount).every(k => braceCount[k] === 0)) {
                    commaCount++;
                }
                break;
            case '(':
            case '{':
            case '[':
                c = braceDict[c];
                braceCount[c] = (braceCount[c] || 0) - 1;
                if (braceCount[c] < 0) {
                    stop = true;
                }
                break;
            case '\'':
            case '"':
                let quote = c;
                while (--index >= 0) {
                    c = exp[index];
                    if (c === quote) {
                        break;
                    }
                }
                break;
            case ']':
            case ')':
            case '}':
                braceCount[c] = (braceCount[c] || 0) + 1;
        }
        if (stop) {
            break;
        }
        index--;
    }
    if (stop) {
        exp = exp.substr(0, index).trim();
        exp = getCurrentExpression(exp);
        return {
            ...getPrefix(exp),
            paramIndex: commaCount
        };
    }
    
    return null;
}

function isArray(obj: any) {
    return obj instanceof Array;
}

function isObject(obj: any) {
    return obj && typeof(obj) === 'object' && obj.constructor === Object;
}

let ID_RE = /^[_a-zA-Z]\w*$/;
function isId(str: string) {
    return ID_RE.test(str);
}

class TrackExpressionContext extends ExpressionContext {
    private accessed: { [key: string]: boolean[] };

    constructor(expVersion: number) {
        super(expVersion);
        this.accessed = {};
    }

    get(key: string) {
        let list = this.accessed[key];
        if (list && list.length > 0) {
            list[list.length - 1] = true;
        }
        return super.get(key);
    }

    push(key: string, value: any) {
        let list = this.accessed[key];
        if (!list) {
            list = [];
            this.accessed[key] = list;
        }
        list.push(false);
        super.push(key, value);
    }

    pop(key: string) {
        let list = this.accessed[key];
        list.pop();
        return super.get(key);
    }

    isAccessed(key: string): boolean {
        let list = this.accessed[key];
        if (list && list.length > 0) {
            return list[list.length - 1];
        }
        return true;
    }
}

export class MistDocument {
    static documents: { [path: string]: MistDocument } = {}

    public readonly document: TextDocument;
    private datas: MistData[];
    private dataFile: string;
    private dataIndex: number = 0;
    private rootNode: json.Node;
    private nodeTree: MistNode;
    private template: any;

    public static getDocumentByUri(uri: Uri) {
        return MistDocument.documents[uri.toString()];
    }

    public static initialize() {
        vscode.workspace.textDocuments.forEach(d => MistDocument.onDidOpenTextDocument(d));
        if (vscode.workspace.rootPath) {
            MistData.openDir(vscode.workspace.rootPath);
        }
    }

    public static onDidOpenTextDocument(document: TextDocument) {
        if (document.languageId === 'mist') {
            MistDocument.documents[document.uri.toString()] = new MistDocument(document);
            if (document.fileName) {
                MistData.openDir(path.dirname(document.fileName));
            }
        }
    }

    public static onDidCloseTextDocument(document: TextDocument) {
        if (document.languageId === 'mist') {
            MistDocument.documents[document.uri.toString()] = null;
        }
    }

    public static onDidSaveTextDocument(document: TextDocument) {
        if (document.languageId === 'mist') {
            
        }
        else if (document.fileName.endsWith('.json')) {
            MistData.openFile(document.fileName);
            vscode.commands.executeCommand('mist.updatePreview')
        }
    }

    public static onDidChangeTextDocument(event: TextDocumentChangeEvent) {
        if (event.document.languageId === 'mist') {
            let mistDocument = MistDocument.getDocumentByUri(event.document.uri);
            mistDocument.onDidChangeTextDocument(event);
        }
    }
    
    constructor(document: TextDocument) {
        this.document = document;
    }

    public clearDatas() {
        this.datas = null;
    }

    public getRootNode(): json.Node {
        return this.rootNode;
    }

    public getRootMistNode(): MistNode {
        this.parseTemplate();
        return this.nodeTree;
    }

    public getTemplate() {
        this.parseTemplate();
        return this.template;
    }

    public getDatas() {
        if (!this.datas) {
            let file = this.document.fileName;
            let dir = path.dirname(file);
            let templateId = path.basename(file, ".mist");
            this.datas = MistData.getData(dir, templateId);
        }
        return this.datas;
    }

    public setData(data: MistData) {
        let datas = this.getDatas();
        if (datas.length === 0) return;
        if (datas.indexOf(data) < 0) {
            data = datas[0];
        }
        this.dataFile = data.file;
        this.dataIndex = data.index || 0;
    }

    public getData() {
        let datas = this.getDatas();
        if (datas && datas.length > 0) {
            if (this.dataFile == null) {
                this.dataFile = datas[0].file;
            }
            let filterdDatas = datas.filter(d => d.file === this.dataFile);
            if (this.dataIndex < filterdDatas.length) {
                return filterdDatas[this.dataIndex];
            }
        }
        return null;
    }

    public dir() {
        if (this.document.fileName) {
            return path.dirname(this.document.fileName);
        }
        return vscode.workspace.rootPath;
    }

    public getExpVersion(): number {
        return this.template && this.template['exp-version'] || 1
    }

    public provideCompletionItems(position: vscode.Position, token: vscode.CancellationToken) {
        NodeSchema.setCurrentDir(this.dir());
        let document = this.document;
        let location = json.getLocation(document.getText(), document.offsetAt(position));
        this.parseTemplate();

        let getWordRange = () => document.getWordRangeAtPosition(position, /[-_$a-zA-Z0-9]+/);

        if (this.shouldProvideCommentCompletion(position)) {
            const ignoreItem = new CompletionItem('@ignore', vscode.CompletionItemKind.Snippet)
            ignoreItem.detail = '取消文件下一行的语义检查错误提示。'
            ignoreItem.range = document.getWordRangeAtPosition(position, /[-@_$a-zA-Z0-9]+/);
            return [ignoreItem]
        }

        // 在上一行没有以逗号结尾时，也认为在 key 里
        if (!location.isAtPropertyKey) {
            let wordRange = getWordRange();
            let p = wordRange ? wordRange.start : position;
            let line = document.getText(new vscode.Range(new vscode.Position(p.line, 0), p)).trim();
            if (line === '') {
                location.isAtPropertyKey = true;
                location.previousNode = null;
                location.path = [...location.path.slice(0, -1), ""];
            }
            else if (line === '"') {
                location.isAtPropertyKey = true;
            }
        }

        // expression suggestions
        var items: CompletionItem[] = [];
        if (!location.isAtPropertyKey) {
            let expression = this.getExpressionAtLocation(location, position);
            if (expression !== null) {
                let { lexerError: error } = parse(expression);
                if (error === LexerErrorCode.UnclosedString) {
                    return [];
                }
                let exp = getCurrentExpression(expression);
                let {prefix: prefix, function: func} = getPrefix(exp);
                let type: IType;
                let ctx = this.contextAtLocation(location);
                const varMethods: Record<string, Method[]> = {}
                
                if (prefix) {
                    type = this.expressionTypeWithContext(prefix, ctx.typeContext);
                }
                else {
                    if (document.getText(new vscode.Range(position.translate(0, -1), position)) === '.') {
                        return [];
                    }
                    type = Type.Global;
                    items = items.concat(['true', 'false', 'null', 'nil'].map(s => new CompletionItem(s, vscode.CompletionItemKind.Keyword)));

                    ctx.vars.forEach(v => {
                        if (v.type instanceof ArrowType) {
                            varMethods[v.name] = [new Method(v.type, v.description, v.type.params)]
                            return
                        }

                        let item = new CompletionItem(v.name, vscode.CompletionItemKind.Variable);
                        item.detail = v.value !== None ? `"${v.name}": ${JSON.stringify(v.value, null, '\t')}` : `${v.name}: ${v.type.getName()}`;
                        let doc = [];
                        if (v.type && v.value === None) {
                            doc.push(v.type.getName());
                        }
                        if (v.description) {
                            doc.push(v.description);
                        }
                        item.documentation = doc.join('\n\n');
                        items.push(item);
                    })
                }
                if (type) {
                    let properties = type.getAllProperties();
                    let methods = { ...varMethods, ...type.getAllMethods(ctx.typeContext) };
                    items = items.concat(Object.keys(properties).filter(isId).map(k => {
                        let p = properties[k];
                        let item = new vscode.CompletionItem(k, type === Type.Global ? vscode.CompletionItemKind.Constant : vscode.CompletionItemKind.Property);
                        if (p.description) {
                            item.documentation = p.description;
                        }
                        if (p.type) {
                            item.detail = this.propertyName(k, p);
                        }
                        return item;
                    }));
                    items = items.concat(Object.keys(methods).map(k => {
                        let m = methods[k];
                        let item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Method);
                        let funInfo = m[0];
                        let params = funInfo.params || [];
                        let noParams = params.length === 0 && m.length === 1;
                        item.insertText = new vscode.SnippetString(k + (noParams ? '()' : '($0)'));
                        if (!noParams) {
                            item.command = {
                                title: 'Trigger Signature Help',
                                command: "editor.action.triggerParameterHints"
                            };
                        }
                        if (m[0].description) {
                            item.documentation = m[0].description;
                        }
                        item.detail = this.methodName(k, m[0], m.length);
                        return item;
                    }));
                    return items;
                }
                return items;
            }
            else {
                let nodePath = this.nodePath(location.path);
                if (nodePath && location.previousNode && nodePath.length >= 2 && nodePath[0] === 'style' && (nodePath[1] === 'image' || nodePath[1] === 'error-image' || nodePath[1] === 'background-image')) {
                    let range = new vscode.Range(document.positionAt(location.previousNode.offset + 1), document.positionAt(location.previousNode.offset + location.previousNode.length - 1));
                    let items = ImageHelper.provideCompletionItems(this, token)
                    items.forEach(item => item.range = range);
                    return items;
                }
            }
        }

        // property suggestions
        let node = this.rootNode;
        let matchingSchemas: Schema[] = [];
        let offset = document.offsetAt(position);
        if (!location.isAtPropertyKey && !location.previousNode) {
            // 用 key 的 offset，否则找不到对应的 schema
            let name = location.path[location.path.length - 1];
            let parentNode = json.findNodeAtLocation(node, location.path.slice(0, -1));
            let propNode = parentNode.children.find(n => n.children[0].value === name);
            if (propNode) {
                offset = propNode.children[0].offset;
            }
        }
        else if (location.isAtPropertyKey && location.previousNode) {
            // 在 key 已经有引号时
            let parentNode = json.findNodeAtLocation(node, location.path.slice(0, -1));
            offset = parentNode.offset;
        }
        validateJsonNode(node, templateSchema, offset, matchingSchemas);
        if (matchingSchemas.length > 0) {
            for (let s of matchingSchemas) {
                if (location.isAtPropertyKey && s && typeof(s) === 'object') {
                    if (s.properties) {
                        let notDeprecated = (s: Schema) => !(s && typeof(s) === 'object' && s.deprecatedMessage);
                        let s1 = s;
                        let existsProperties = json.findNodeAtLocation(node, location.path.slice(0, -1)).children.map(c => c.children[0].value);
                        items.push(...Object.keys(s.properties)
                            .filter(k => notDeprecated(s1.properties[k]))
                            .filter(k => existsProperties.indexOf(k) < 0)
                            .map(k => {
                                let s = s1.properties[k];
                                let item = new CompletionItem(k, vscode.CompletionItemKind.Property);
    
                                if (s && typeof(s) === 'object') {
                                    switch (s.format) {
                                        case 'event': item.kind = vscode.CompletionItemKind.Event; break;
                                    }
                                    if (s.description) {
                                        item.detail = s.description;
                                    }
                                }
    
                                let valueText = (inQuote: boolean) => {
                                    if (!location.isAtPropertyKey) {
                                        return '';
                                    }
                    
                                    let valueText = '';
                                    let comma = false;
                                    let pos = inQuote ? position.translate(0, 1) : position;
                                    let text = document.getText(new vscode.Range(pos, pos.translate(5, 0)));
                                    if (text.match(/^\s*"/)) {
                                        comma = true;
                                    }
                                    let value = this.schemaSnippet(s) || '$0';
                                    valueText += `: ${value}`;
                                    if (comma) {
                                        valueText += ',';
                                    }
                                    
                                    return valueText;
                                }
    
                                if (location.previousNode) {
                                    let offset = document.offsetAt(position);
                                    let delta = offset - location.previousNode.offset;
                                    let inQuote = delta > 0 && delta < location.previousNode.length;
                                    if (inQuote) {
                                        item.insertText = new vscode.SnippetString(`${k}"${valueText(true)}`);
                                        item.range = new vscode.Range(document.positionAt(location.previousNode.offset + 1), document.positionAt(location.previousNode.offset + location.previousNode.length));
                                    }
                                    else {
                                        item.insertText = `"${k}"`;
                                        item.range = new vscode.Range(document.positionAt(location.previousNode.offset), document.positionAt(location.previousNode.offset + location.previousNode.length));
                                    }
                                } else {
                                    item.range = getWordRange();
                                    item.insertText = new vscode.SnippetString(`"${k}"${valueText(false)}`);
                                }

                                let text = typeof(item.insertText) === 'string' ? item.insertText : item.insertText.value;
                                if (!text.includes('\n') && !k.startsWith('margin') && k !== 'width' && k !== 'height' && k !== 'flex-basis') {
                                    item.command = {
                                        title: "",
                                        command: "mist.triggerSuggest"
                                    };
                                }
                                
                                return item;
                            }));
                    }
                }
                else if (!location.isAtPropertyKey && s && typeof(s) === 'object') {
                    let enums = this.schemaEnums(s);
                    if (location.previousNode) {
                        enums = enums.filter(s => typeof(s[0]) === 'string');
                        items.push(...enums.map(e => {
                            let item = new CompletionItem(e[0], e[2]);
                            if (e[1]) {
                                item.detail = e[1];
                            }
                            item.command = {
                                title: "Move To Line End",
                                command: "mist.moveToLineEnd"
                            };
                            item.range = getWordRange();
                            return item;
                        })); 
                    }
                    else {
                        items.push(...enums.map(e => {
                            let item = new CompletionItem(JSON.stringify(e[0]), e[2]);
                            if (e[1]) {
                                item.detail = e[1];
                            }
                            item.command = {
                                title: "Move To Line End",
                                command: "mist.moveToLineEnd"
                            };
                            item.range = getWordRange();
                            return item;
                        })); 
                    }
                }
            }
        }

        // snippets
        if (!location.previousNode) {
            let nodePath = this.nodePath(location.path);
            let snippets: any = Snippets.nodeSnippets;
            if (nodePath && nodePath.length === 0) {
                let trialingText = this.document.getText(new vscode.Range(position, position.translate(3, 0)));
                let needTrialingComma = trialingText.trim().startsWith('{');
                snippets = Object.keys(snippets).reduce((p, c) => {
                    p[c] = '{\n  ' + snippets[c].replace(/\n/mg, '\n  ') + '\n}';
                    if (needTrialingComma) p[c] += ',';
                    return p;
                }, {});
            }
            else if (nodePath && nodePath.length === 1 && location.isAtPropertyKey) {
                let node = this.nodeAtPath(location.path);
                if (node.node.children.length > 0) {
                    return items;
                }
            }
            else {
                return items;
            }
            items.push(...Object.keys(snippets).map(name => {
                let item = new CompletionItem(name, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(snippets[name]);
                return item;
            }));
        }

        return items;
    }
    
    private shouldProvideCommentCompletion(position: vscode.Position) {
        const line = this.document.lineAt(position.line)
        const offset = this.document.offsetAt(position) - this.document.offsetAt(line.range.start)
        const scanner = json.createScanner(line.text, false)
        let type: json.SyntaxKind
        do {
            type = scanner.scan()
            const start = scanner.getTokenOffset()
            const end = start + scanner.getTokenLength()
            if (start > offset) {
                break
            }
            else if (offset <= end) {
                if (type === json.SyntaxKind.LineCommentTrivia) {
                    const text = this.document.getText(new vscode.Range(position.translate(0, -4), position))
                    return text.match(/\/\/ ?@?$/)
                }
                return false
            }
        } while (type !== json.SyntaxKind.EOF)
        return false
    }

    public provideHover(position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        NodeSchema.setCurrentDir(this.dir());

        let contentsFromProperty = (name: string, prop: Property): vscode.MarkedString[] => {
            let contents: vscode.MarkedString[] = [];
            contents.push({language: 'typescript', value: this.propertyName(name, prop)});
            if (prop.description) {
                contents.push(prop.description);
            }
            return contents;
        }
        
        let contentsFromMethod = (name: string, fun: Method, count: number): vscode.MarkedString[] => {
            let contents: vscode.MarkedString[] = [];
            contents.push({language: 'typescript', value: this.methodName(name, fun, count)});
            if (fun.description) {
                contents.push(fun.description);
            }
            return contents;
        }
        
        let document = this.document;
        let wordRange = document.getWordRangeAtPosition(position, /[-_$a-zA-Z0-9]+/);
        if (wordRange == null || wordRange.start === wordRange.end) {
            return;
        }
        let location = json.getLocation(document.getText(), document.offsetAt(position));
        this.parseTemplate();

        let expression = this.getExpressionAtLocation(location, wordRange.end);
        if (expression != null) {
            expression = getCurrentExpression(expression);
            let isFunction = document.getText(new vscode.Range(wordRange.end, wordRange.end.translate(0, 1))) === '(';
            let contents: vscode.MarkedString[] = [];
            let ctx = this.contextAtLocation(location);
            let {prefix: prefix, function: func} = getPrefix(expression);
            let type: IType;
            if (prefix) {
                type = this.expressionTypeWithContext(prefix, ctx.typeContext);
            }
            else {
                let v = ctx.vars.find(v => v.name === func);
                if (v) {
                    // if (v.value !== None) {
                    //     contents.push({ language: 'mist', value: `"${v.name}": ${JSON.stringify(v.value, null, '\t')}` });
                    // }
                    if (v.type) {
                        contents.push({ language: 'typescript', value: `"${v.name}": ${v.type.getName()}` });
                    }
                    if (v.description) {
                        contents.push(v.description);
                    }
                }
                else if (isFunction) {
                    type = Type.Global
                }
            }

            if (type) {
                if (isFunction) {
                    let fun = type.getMethods(func, ctx.typeContext);
                    if (fun && fun.length > 0) {
                        let current;
                        if (fun.length > 1) {
                            let paramsCount = getFunctionParamsCount(this.getTrailingExpressionAtLocation(location, wordRange.end));
                            current = fun.find(f => f.params.length === paramsCount);
                        }
                        contents.push(...contentsFromMethod(func, current || fun[0], fun.length));
                    }
                    else {
                        let prop = type.getProperty(func);
                        if (prop) {
                            contents.push(...contentsFromProperty(func, prop));
                        }
                    }
                }
                else {
                    let prop = type.getProperty(func);
                    if (prop) {
                        contents.push(...contentsFromProperty(func, prop));
                    }
                    else {
                        let fun = type.getMethod(func, 0, ctx.typeContext);
                        if (fun && fun.type && fun.type !== Type.Void) {
                            contents.push(...contentsFromMethod(func, fun, type.getMethods(func, ctx.typeContext).length));
                        }
                    }
                }
                
            }
            
            return new Hover(contents);
        }
        
        let node = this.rootNode;
        let matchingSchemas: Schema[] = [];
        let range = new vscode.Range(
            document.positionAt(location.previousNode.offset),
            document.positionAt(location.previousNode.offset + location.previousNode.length)
        );
        let offset = document.offsetAt(position);
        validateJsonNode(node, templateSchema, offset, matchingSchemas);
        if (matchingSchemas.length > 0) {
            let s = matchingSchemas[0]; // TODO
            if (!location.isAtPropertyKey && s && typeof(s) === 'object') {
                if (s.enum && s.enumDescriptions) {
                    let value = getNodeValue(json.findNodeAtLocation(node, location.path));
                    let index = s.enum.indexOf(value);
                    if (index >= 0) {
                        return new Hover(s.enumDescriptions[index], range);
                    }
                }
            }
            if (s && typeof(s) === 'object' && s.description) {
                return new Hover(s.description, range);
            }
        }
        return null;
    }

    public provideDefinition(position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Definition> {
        let document = this.document;
        let wordRange = document.getWordRangeAtPosition(position);
        if (wordRange == null || wordRange.start === wordRange.end) {
            return null;
        }
        let location = json.getLocation(document.getText(), document.offsetAt(position));
        this.parseTemplate();

        let expression = this.getExpressionAtLocation(location, wordRange.end);
        if (!expression) {
            return null;
        }
        expression = getCurrentExpression(expression);
        let {prefix: prefix, function: name} = getPrefix(expression);
        if (prefix) {
            return null;
        }
        // let isFunction = document.getText(new vscode.Range(wordRange.end, wordRange.end.translate(0, 1))) === '(';
        // if (isFunction) {
        //     return null;
        // }
        let ctx = this.contextAtLocation(location);
        let index = findLastIndex(ctx.vars, v => v.name === name);
        if (index >= 0) {
            let v = ctx.vars[index];
            if (v.node) {
                let uri = v.uri || this.document.uri;
                return vscode.workspace.openTextDocument(uri).then(doc => {
                    return new vscode.Location(uri, new vscode.Range(doc.positionAt(v.node.offset), doc.positionAt(v.node.offset + v.node.length)));
                });
            }
        }
        return null;
    }

    public provideSignatureHelp(position: vscode.Position, token: vscode.CancellationToken): vscode.SignatureHelp | Thenable<vscode.SignatureHelp> {
        let document = this.document;
        let location = json.getLocation(document.getText(), document.offsetAt(position));
        this.parseTemplate();

        let expression = this.getExpressionAtLocation(location, position);
        if (expression) {
            let signatureInfo = getSignatureInfo(expression);
            if (signatureInfo) {
                let type: IType;
                if (signatureInfo.prefix) {
                    let ctx = this.contextAtLocation(location);
                    type = this.expressionTypeWithContext(signatureInfo.prefix, ctx.typeContext);
                }
                else {
                    type = Type.Global;
                }
                if (!type) {
                    return null;
                }

                let fun = type.getMethods(signatureInfo.function, this.contextAtLocation(location).typeContext);
                if (fun && fun.length > 0) {
                    let signatureHelp = new vscode.SignatureHelp();
                    signatureHelp.signatures = fun.map(f => {
                        let signature = new vscode.SignatureInformation(this.methodName(signatureInfo.function, f, fun.length));
                        signature.parameters = (f.params || []).map(p => new vscode.ParameterInformation(`${p.name}: ${p.type.getName()}`));
                        signature.documentation = f.description;
                        return signature;
                    });
                    signatureHelp.activeSignature = 0;
                    signatureHelp.activeParameter = signatureInfo.paramIndex;
                    return signatureHelp;
                }
            }
        }

        return null;
    }

    public validate(): vscode.Diagnostic[] {
        NodeSchema.setCurrentDir(this.dir());
        this.parseTemplate();
        if (!this.template) return [];
        let vars: Variable[] = [];
        let typeContext = new TrackExpressionContext(this.getExpVersion());

        let diagnostics = [];

        let pushVariable = (v: Variable, isConst: boolean = false) => {
            vars.push(v);
            let isExp = false;
            let parsed = parseExpressionInObject(v.value);
            if (this.hasExpression(parsed)) {
                isExp = true;
                if (!v.type) {
                    v.type = this.computeExpressionTypeInObject(parsed, typeContext, isConst);
                }
            }
            if (!v.type) {
                v.type = (isConst ? Type.typeof(v.value, isConst) : this.getDataType(v.value)) || Type.Any;
            }
            if (v.incomplete && v.type instanceof ObjectType) {
                v.type.setIndexType();
            }
            typeContext.push(v.name, v.type);
        };
        let push = (key, value) => pushVariable(new Variable(key, value));
        let pop = key => {
            let index = findLastIndex(vars, v => v.name === key);
            if (index >= 0) {
                if (!typeContext.isAccessed(key)) {
                    let v = vars[index];
                    if (v.node && !v.uri) {
                        let node = v.node.children[0];
                        diagnostics.push(new vscode.Diagnostic(nodeRange(node), `未引用的变量 \`${key}\``, vscode.DiagnosticSeverity.Warning));
                    }
                }
                vars.splice(index, 1);
            }
            typeContext.pop(key);
        };
        let pushDict = dict => Object.keys(dict).forEach(key => push(key, dict[key]));
        let pushVarsDict = (node: json.Node, isConst: boolean = false) => {
            const scopeVars = node.children.map(c => c.children[0].value)
            let pushed = [];
            node.children.forEach(c => {
                if (c.children.length === 2) {
                    const key = c.children[0].value;
                    validate(c.children[1], scopeVars.filter(v => v !== key));
                    pushVariable(new Variable(key, getNodeValue(c.children[1])).setNode(c), isConst);
                    pushed.push(key);
                }
            });
            return pushed;
        }

        let range = (offset, length) => {
            let start = this.document.positionAt(offset);
            let end = this.document.positionAt(offset + length);
            return new vscode.Range(start, end);
        }
        let nodeRange = (node: json.Node) => {
            return range(node.offset, node.length);
        }

        let validate = (node: json.Node, scopeVars: string[] = undefined) => {
            if (!node) return;
            if (node.type === 'object') {
                node.children.forEach(child => {
                    if (child.children.length >= 2) {
                        validate(child.children[1], scopeVars);
                    }
                });
            }
            else if (node.type === 'array') {
                node.children.forEach(c => validate(c, scopeVars));
            }
            else if (node.type === 'string') {
                let expressions = this.findExpressionsInString(node);
                expressions.forEach(exp => {
                    if (exp.string.errors.length > 0) {
                        return;
                    }
                    let { expression: expNode, errorMessage: error, errorOffset: offset, errorLength: length } = parse(exp.string.parsed);
                    if (error) {
                        let start = exp.string.sourceIndex(offset);
                        let end = exp.string.sourceIndex(offset + length);
                        diagnostics.push(new vscode.Diagnostic(range(start + exp.offset + node.offset, end - start), error, vscode.DiagnosticSeverity.Error));
                    }
                    else {
                        let errors = expNode.check(typeContext);
                        if (errors && errors.length > 0) {
                            diagnostics.push(...errors.map(e => {
                                let start = exp.string.sourceIndex(e.offset);
                                let end = exp.string.sourceIndex(e.offset + e.length);
                                return new vscode.Diagnostic(range(start + exp.offset + node.offset, end - start), e.description, 
                                    e.level === ExpressionErrorLevel.Info ? vscode.DiagnosticSeverity.Information :
                                    e.level === ExpressionErrorLevel.Warning ? vscode.DiagnosticSeverity.Warning :
                                    vscode.DiagnosticSeverity.Error);
                            }));
                        }

                        if (scopeVars && scopeVars.length > 0) {
                            const ids: IdentifierNode[] = []
                            const ctx = new TrackExpressionContext(this.getExpVersion())
                            for (const v of scopeVars) {
                                ctx.push(v, true)
                            }
                            expNode.check(ctx)
                            expNode.visitNode(node => {
                                if (node instanceof IdentifierNode) {
                                    ids.push(node)
                                }
                            })
                            for (const id of ids) {
                                if (scopeVars.indexOf(id.identifier) >=0 && ctx.isAccessed(id.identifier)) {
                                    let start = exp.string.sourceIndex(id.offset);
                                    let end = exp.string.sourceIndex(id.offset + id.length);
                                    diagnostics.push(new vscode.Diagnostic(range(start + exp.offset + node.offset, end - start), `不能引用同一字典中定义的变量 \`${id.identifier}\`，由于 JSON 字典是无序处理的，会导致未定义行为。\n\n可以将 vars 定义为数组，如："vars": [{"a": 1}, {"b": "\${a}"}]`, vscode.DiagnosticSeverity.Error));
                                }
                            }
                        }
                    }
                });
            }
        }

        let resolveValueTypesInNode = (node: TypedNode) => {
            if (node.valueType) return;
            if (node.type === 'string') {
                let parsed = parseExpressionInObject(node.value);
                if (parsed === null) {
                    node.valueType = Type.Any;
                }
                else {
                    node.valueType = this.computeExpressionTypeInObject(parsed, typeContext, true);
                }
            }
            else if (node.type === 'array') {
                node.children.forEach(c => resolveValueTypesInNode(c));
            }
            else if (node.type === 'object') {
                node.children.forEach(c => {
                    if (c.children.length === 2) resolveValueTypesInNode(c.children[1]);
                });
            }
        };

        let validateProperty = (node: json.Node, schema: Schema) => {
            if (!node) return;
            if (node.type !== 'property') {
                node = node.parent;
            }
            if (!node || node.type !== 'property') return;
            if (typeof(schema) !== 'object') return;
            let keyNode = node.children[0];
            let valueNode = node.children[1];
            if (!valueNode) return;
            let key = keyNode.value;
            let s = schema.properties[key];
            if (!valueNode) return;
            validate(valueNode);
            resolveValueTypesInNode(valueNode);
            if (s) {
                let errors = validateJsonNode(valueNode, s);
                diagnostics.push(...errors.map(e => new vscode.Diagnostic(range(e.node.offset, e.node.length), e.error, vscode.DiagnosticSeverity.Warning)));
            }
            else {
                if (!schema.additionalProperties) {
                    let desc = `不存在属性 \`${key}\``;
                    let style = schema.properties.style;
                    let inStyle = style && typeof(style) === 'object' && key in style.properties;
                    if (inStyle) {
                        desc += `，是否想使用 \`style\` 中的 \`${key}\``;
                    }
                    diagnostics.push(new vscode.Diagnostic(range(keyNode.offset, keyNode.length), desc, vscode.DiagnosticSeverity.Warning));
                }
            }
        }

        let assertNoExp = (node: json.Node) => {
            if (node && node.type === 'string') {
                let expressions = this.findExpressionsInString(node);
                if (expressions.length > 0) {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(node), '该属性不支持使用表达式', vscode.DiagnosticSeverity.Error));
                }
            }
        }
        
        let noExpProps = ['identifier', 'async-display', 'cell-height-animation', 'reuse-identifier'];
        
        BUILTIN_VARS.forEach(v => pushVariable(v)); 

        let data = this.getData() ? this.getData().data : {};

        pushDict(data);
        pushVariable(new Variable('_data_', this.getDataType(data), _DATA_DESC, true));

        validateProperty(json.findNodeAtLocation(this.rootNode, ['data']), templateSchema);
        if (this.template.data instanceof Object) {
            data = {...data, ...this.template.data};
        }
        pushDict(data);

        pushVariable(new Variable('_data_', this.getDataType(data), _DATA_DESC, true));

        pushDict({
            '_item_': Type.Null,
            '_index_': Type.Null,
        });

        validateProperty(json.findNodeAtLocation(this.rootNode, ['state']), templateSchema);
        pushVariable(new Variable('state', this.template.state || null, '模版状态', true));

        this.rootNode.children.forEach(c => {
            let key = c.children[0].value;
            if (key === 'layout' || key === 'data' || key === 'state') {
                return;
            }

            if (noExpProps.indexOf(key) >= 0) {
                assertNoExp(c.children[1]);
            }
            validateProperty(c, templateSchema);
        });

        const accessibilityCheckEnabled = this.template['disable-accessibility-check'] !== true
        let hasAccessibilityDepth = 0;
        
        let validateNode = (node: MistNode) => {
            if (!node) return;
            if (node.node.type === 'string') {
                let expressions = this.findExpressionsInString(node.node);
                if (expressions.length === 1 && expressions[0].offset === 3 && expressions[0].string.source.length === node.node.length - 5) {
                    
                }
                else {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(node.node), '`node` 必须为 `object` 类型', vscode.DiagnosticSeverity.Error));
                    return;
                }
                validate(node.node);
                return;
            }
            else if (node.node.type !== 'object') {
                diagnostics.push(new vscode.Diagnostic(nodeRange(node.node), '`node` 必须为 `object` 类型', vscode.DiagnosticSeverity.Error));
                return;
            }
            let pushed = [];
            let schema = new NodeSchema().getSchema(node.node);
            let repeatNode = getPropertyNode(node.node, 'repeat');
            if (repeatNode) {
                validateProperty(repeatNode.parent, schema);
                pushVariable(new Variable('_index_', Type.Number, '当前 `repeat` 元素索引'));
                let repeatType: IType = repeatNode.value;
                if (!(repeatType instanceof IType)) {
                    repeatType = Type.Any;
                }
                let valueType = repeatType.getTypeAtIndex(Type.Number);
                pushVariable(new Variable('_item_', valueType, '当前 `repeat` 元素'));
                pushed.push('_item_', '_index_');
            }
            let varsNode = getPropertyNode(node.node, 'vars');
            if (varsNode) {
                if (varsNode.type === 'array') {
                    varsNode.children.forEach(c => {
                        if (c.type !== 'object') {
                            diagnostics.push(new vscode.Diagnostic(nodeRange(c), '必须为 `object` 类型', vscode.DiagnosticSeverity.Error));
                            return;
                        }

                        pushed.push(...pushVarsDict(c, true));
                    });
                }
                else if (varsNode.type === 'object') {
                    pushed.push(...pushVarsDict(varsNode, true));
                }
                else {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(varsNode), '`vars` 属性只能为 `object` 或 `array`', vscode.DiagnosticSeverity.Error));
                }
            }
            const list = ['repeat', 'vars', 'children'];
            let otherNodes = node.node.children.filter(n => n.children.length === 2 && list.indexOf(n.children[0].value) < 0);
            if (typeof(schema) === 'object') {
                let childrenNode = json.findNodeAtLocation(node.node, ['children']);
                if (childrenNode && !schema.properties['children'] && schema.additionalProperties === false) {
                    let keyNode = childrenNode.parent.children[0];
                    diagnostics.push(new vscode.Diagnostic(nodeRange(keyNode), '不存在属性 `children`', vscode.DiagnosticSeverity.Warning));
                }
                otherNodes.forEach(n => {
                    const key = n.children[0].value
                    if (typeof key !== 'string') return

                    const isEvent = key.startsWith('on-')
                    if (isEvent) {
                        push('_event_', this.getEventParamsType(key))
                    }

                    validateProperty(n, schema)

                    if (isEvent) {
                        pop('_event_')
                    }
                });
            }

            const styleNode = getPropertyNode(node.node, 'style')
            const typeNode = getPropertyNode(node.node, 'type')
            const type = typeNode && typeNode.value
            if (type === 'image') {
                if (styleNode) {
                    const hasClip = !!getPropertyNode(styleNode, 'clip')
                    const modeNode = getPropertyNode(styleNode, 'content-mode')
                    const mode = (modeNode && modeNode.value) || 'scale-to-fill'
                    if (mode === 'scale-aspect-fill' && !hasClip) {
                        diagnostics.push(new vscode.Diagnostic(nodeRange(modeNode), '设置 `scale-aspect-fill` 时，需要显式指定 clip 属性，一般设置为 true。 clip 默认为 false，可能导致图片绘制超出', vscode.DiagnosticSeverity.Warning))
                    }
                }
            }

            // 无障碍检查
            // 1. 对于非 text, button 类型的节点，如果打开了 is-accessibility-element，必须同时设置 accessibility-label，自行拼接朗读的文本
            // 2. 嵌套的两个节点不能同时打开 is-accessibility-element
            // 3. 有 on-tap 的节点必须设置 is-accessibility-element 属性（可以设置为 false）
            if (accessibilityCheckEnabled) {
                const isA11yNode = getPropertyNode(styleNode, 'is-accessibility-element')
                const a11yLabelNode = getPropertyNode(styleNode, 'accessibility-label')

                if (isA11yNode && isA11yNode.value !== true && isA11yNode.value !== false) {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(isA11yNode), '【无障碍检查】`is-accessibility-element` 应始终设置为常量，而不要使用表达式，只能设置为 true 或 false\n\n*如果确定不需要进行无障碍适配，可以在模板根节点设置 `disable-accessibility-check` 属性关闭无障碍检查*', vscode.DiagnosticSeverity.Error))
                }

                if (a11yLabelNode && (!isA11yNode || isA11yNode.value !== true)) {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(isA11yNode || a11yLabelNode), '【无障碍检查】如果设置了 `accessibility-label`，请同时设置 `is-accessibility-element: true`，否则是未定义行为，两端效果可能不一致\n\n*如果确定不需要进行无障碍适配，可以在模板根节点设置 `disable-accessibility-check` 属性关闭无障碍检查*', vscode.DiagnosticSeverity.Error))
                }

                if (isA11yNode && isA11yNode.value === true && !a11yLabelNode && type !== 'text' && type !== 'button') {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(isA11yNode.parent.children[0]), '【无障碍检查】对于非 `text`, `button` 类型的节点，如果打开了 `is-accessibility-element`，必须同时设置 `accessibility-label`，自行拼接朗读的文本\n\n*如果确定不需要进行无障碍适配，可以在模板根节点设置 `disable-accessibility-check` 属性关闭无障碍检查*', vscode.DiagnosticSeverity.Error))
                }

                if (isA11yNode && isA11yNode.value === true) {
                    if (hasAccessibilityDepth > 0) {
                        diagnostics.push(new vscode.Diagnostic(nodeRange(isA11yNode), '【无障碍检查】嵌套的两个节点不能同时打开 `is-accessibility-element`\n\n*如果确定不需要进行无障碍适配，可以在模板根节点设置 `disable-accessibility-check` 属性关闭无障碍检查*', vscode.DiagnosticSeverity.Error))
                    }
                    hasAccessibilityDepth++;
                }

                const onTapNode = getPropertyNode(node.node, 'on-tap')
                if (onTapNode && !isA11yNode) {
                    diagnostics.push(new vscode.Diagnostic(nodeRange(onTapNode.parent.children[0]), '【无障碍检查】有 `on-tap` 的节点必须设置 `is-accessibility-element` 属性（可以设置为 false）\n\n*如果确定不需要进行无障碍适配，可以在模板根节点设置 `disable-accessibility-check` 属性关闭无障碍检查*', vscode.DiagnosticSeverity.Error))
                }
            }

            if (node.children) {
                node.children.forEach(validateNode);
            }

            if (accessibilityCheckEnabled) {
                const isA11yNode = getPropertyNode(styleNode, 'is-accessibility-element')
                if (isA11yNode && isA11yNode.value === true) {
                    hasAccessibilityDepth--;
                }
            }

            pushed.forEach(pop);
        };

        validateNode(this.nodeTree);

        // 检查 exp-version
        const layoutNode = getPropertyNode(this.rootNode, 'layout')
        const expVersionNode = getPropertyNode(this.rootNode, 'exp-version')
        if (layoutNode && (!expVersionNode || expVersionNode.value < 2)) {
            diagnostics.push(new vscode.Diagnostic(nodeRange(expVersionNode || layoutNode.parent.children[0]), '建议使用新版本表达式，详见[文档](https://yuque.antfin-inc.com/mist/doc/yqsn0x#185f7bf6)', vscode.DiagnosticSeverity.Warning))
        }
        
        return diagnostics;
    }

    private onDidChangeTextDocument(event: TextDocumentChangeEvent) {
        this.template = null;
        this.rootNode = null;
    }

    private parseTemplate() {
        if (!this.rootNode || !this.template) {
            this.rootNode = parseJson(this.document.getText());
            if (this.rootNode) {
                this.template = getNodeValue(this.rootNode);
                let layoutNode = getPropertyNode(this.rootNode, "layout");
                if (layoutNode) {
                    this.nodeTree = new MistNode(layoutNode);
                }
            }
        }
    }

    // "abc ${expression1} ${a + max(a, b.c|) + d} xxx" ⟹ ") + d"
    // "$:a + max(a, b.c|) + d" ⟹ ) + d
    private getTrailingExpressionAtLocation(location: json.Location, position: vscode.Position) {
        let document = this.document;
        if (!location.isAtPropertyKey && location.previousNode.type === 'string') {
            let start = location.previousNode.offset + 1;
            let end = location.previousNode.offset + location.previousNode.length - 1;
            let str = document.getText(new vscode.Range(document.positionAt(start), document.positionAt(end)));
            let pos = document.offsetAt(position) - start;

            if (str.startsWith("$:")) {
                if (pos >= 2) {
                    let s = str.substring(pos);
                    return json.parse(`"${s}"`);
                }
                else {
                    return null;
                }
            }

            let match;
            MIST_EXP_RE.lastIndex = 0;
            while (match = MIST_EXP_RE.exec(str)) {
                if (pos >= match.index + 2 && pos <= match.index + match[0].length - 1) {
                    let str = match[0].slice(pos - match.index, -1);
                    return json.parse(`"${str}"`);
                }
            }
        }
        return null;
    }

    // "abc ${expression1} ${a + max(a, b.c|) + d} xxx" ⟹ "a + max(a, b.c"
    // "$:a + max(a, b.c|) + d" ⟹ "a + max(a, b.c"
    private getExpressionAtLocation(location: json.Location, position: vscode.Position) {
        let document = this.document;
        if (!location.isAtPropertyKey && location.previousNode && location.previousNode.type === 'string') {
            let start = location.previousNode.offset + 1;
            let end = location.previousNode.offset + location.previousNode.length - 1;
            let str = document.getText(new vscode.Range(document.positionAt(start), document.positionAt(end)));
            let pos = document.offsetAt(position) - start;

            if (str.startsWith("$:")) {
                if (pos >= 2) {
                    let s = str.substring(2, pos);
                    return json.parse(`"${s}"`);
                }
                else {
                    return null;
                }
            }

            let match;
            MIST_EXP_RE.lastIndex = 0;
            while (match = MIST_EXP_RE.exec(str)) {
                if (pos >= match.index + 2 && pos <= match.index + match[0].length - 1) {
                    let str = match[0].substring(2, pos - match.index);
                    return json.parse(`"${str}"`);
                }
            }
        }
        return null;
    }

    public nodeAtOffset(node: MistNode, offset: number): MistNode {
        if (offset >= node.node.offset && offset <= node.node.offset + node.node.length) {
            if (node.children) {
                for (let child of node.children) {
                    let node = this.nodeAtOffset(child, offset);
                    if (node) {
                        return node;
                    }
                }
            }
            return node;
        }
        return null;
    }

    private nodePath(path: json.Segment[]): json.Segment[] {
        if (path.length > 0 && path[0] === "layout") {
            let start = 1;
            while (start + 1 < path.length && path[start] === "children" && path[start + 1] as number !== undefined) {
                start += 2;
            }
            return path.slice(start);
        }
        
        return null;
    }

    private nodeAtPath(path: json.Segment[]) {
        if (!(path.length >= 1 && path[0] === 'layout')) {
            return null;
        }
        path.splice(0, 1);
        let node = this.nodeTree;
        // @ts-ignore
        while (path.length >= 2 && path[0] === 'children' && typeof(path[1]) === 'number') {
            node = node.children[path[1]];
            path.splice(0, 2);
        }
        return node;
    }

    private computeExpressionValueInObject(obj: any, context: ExpressionContext) {
        if (obj instanceof ExpressionNode) {
            return obj.compute(context);
        }
        else if (obj instanceof Array) {
            let list = obj.map(o => this.computeExpressionValueInObject(o, context));
            return list.some(v => v === None) ? None : list;
        }
        else if (obj && obj !== None && typeof(obj) === 'object') {
            let values = Object.keys(obj).map(k => this.computeExpressionValueInObject(obj[k], context));
            if (values.some(v => v === None)) return None;
            return Object.keys(obj).reduce((p, c, i) => { p[c] = values[i]; return p; }, {});
        }
        return obj;
    }

    private computeExpressionTypeInObject(obj: any, context: ExpressionContext, isConst: boolean = false) {
        if (obj instanceof ExpressionNode) {
            return obj.getType(context);
        }
        else if (obj instanceof Array) {
            let types = obj.map(o => this.computeExpressionTypeInObject(o, context, isConst));
            return isConst ? ArrayType.tuple(types) : new ArrayType(UnionType.type(types));
        }
        else if (obj && obj !== None && typeof(obj) === 'object') {
            return new ObjectType(Object.keys(obj).reduce((p, c) => { p[c] = this.computeExpressionTypeInObject(obj[c], context, isConst); return p; }, {}));
        }
        return Type.typeof(obj, isConst);
    }

    private hasExpression(obj: any) {
        if (obj instanceof ExpressionNode) {
            return true;
        }
        else if (obj instanceof Array) {
            return obj.some(o => this.hasExpression(o));
        }
        else if (obj && obj !== None && typeof(obj) === 'object') {
            return Object.keys(obj).some(k => this.hasExpression(obj[k]));
        }
        return false;
    }

    private contextAtLocation(location: json.Location): {
        vars: Variable[],
        typeContext: ExpressionContext
    } {
        let vars: Variable[] = [];
        let typeContext = new ExpressionContext(this.getExpVersion());

        let pushVariable = (v: Variable, isConst: boolean = false) => {
            vars.push(v);
            let isExp = false;
            let parsed = parseExpressionInObject(v.value);
            if (this.hasExpression(parsed)) {
                isExp = true;
                if (!v.type) {
                    v.type = this.computeExpressionTypeInObject(parsed, typeContext, isConst);
                }
            }
            if (!v.type) {
                v.type = Type.typeof(v.value, isConst) || Type.Any;
            }
            if (v.incomplete && v.type instanceof ObjectType) {
                v.type.setIndexType();
            }
            typeContext.push(v.name, v.type);
        };
        let pushVarsDict = (node: json.Node, isConst: boolean = false) => {
            if (!node) return [];
            let pushed = [];
            node.children.forEach(c => {
                if (c.children.length === 2) {
                    let key = c.children[0].value;
                    pushVariable(new Variable(key, getNodeValue(c.children[1])).setNode(c), isConst);
                    pushed.push(key);
                }
            });
            return pushed;
        }
        
        BUILTIN_VARS.forEach(v => pushVariable(v));
        
        let data = this.getData();
        let dataDict = data ? data.data : {};

        if (data) {
            data.node.children.forEach(c => {
                if (c.children.length === 2) {
                    let key = c.children[0].value;
                    pushVariable(new Variable(key, getNodeValue(c.children[1])).setNode(c, data.file));
                }
            });
        }
        
        pushVariable(new Variable('_data_', dataDict, _DATA_DESC, true));

        if (this.template.data instanceof Object) {
            dataDict = {...dataDict, ...this.template.data};
        }
        pushVarsDict(json.findNodeAtLocation(this.rootNode, ['data']));

        pushVariable(new Variable('_data_', dataDict, _DATA_DESC, true));

        if (location.path[0] !== 'data' && location.path[0] !== 'state') {
            pushVariable(new Variable('state', this.template.state || null, '模版状态', true));
        }
        
        let path = [...location.path];
        let node = this.nodeAtPath(path);
        let inRepeat = path.length > 0 && path[0] === 'repeat';
        let nodeStack = [];
        while (node) {
            nodeStack.push(node);
            node = node.parent;
        }
        while (nodeStack.length > 0) {
            let node = nodeStack.pop();
            if (!(inRepeat && nodeStack.length === 0)) {
                let repeatNode = getPropertyNode(node.node, 'repeat');
                if (repeatNode) {
                    pushVariable(new Variable('_index_', Type.Number, '当前 `repeat` 元素索引'));
                    let repeatType: IType = repeatNode.value;
                    if (!(repeatType instanceof IType)) {
                        repeatType = Type.Any;
                    }
                    let valueType = repeatType.getTypeAtIndex(Type.Number);
                    pushVariable(new Variable('_item_', valueType, '当前 `repeat` 元素'));
                }
                let varsNode = getPropertyNode(node.node, 'vars');
                if (varsNode) {
                    if (varsNode.type === 'array') {
                        var count = varsNode.children.length;
                        if (nodeStack.length === 0 && path.length >= 2 && path[0] === 'vars' && typeof(path[1]) === 'number') {
                            count = path[1] as number;
                        }
                        for (var i = 0; i < count; i++) {
                            pushVarsDict(varsNode.children[i], true);
                        }
                    }
                    else if (varsNode.type === 'object') {
                        pushVarsDict(varsNode, true);
                    }
                }
            }
        }

        let inEvent = path.length > 0 && (path[0] as string).startsWith('on-')
        if (inEvent) {
            let eventParamsName = '_event_'
            pushVariable(new Variable(eventParamsName, this.getEventParamsType(path[0] as string), '事件回调对象'))
        }

        return {
            vars: Variable.unique(vars),
            typeContext: typeContext   
        };
    }

    private getEventParamsType(eventName: string) {
        const eventType = Type.registerType(new Type('event').registerPropertys({
            'sender': new Property(Type.getType('View'), '触发事件的 View，某些事件 View 可能为空'),
        }))

        eventName = eventName.replace(/-once$/, '')
        const params = eventParamsMap[eventName]
        if (params) {
            Object.keys(params).forEach(k => {
                eventType.registerProperty(k, new Property(params[k].type, params[k].description))
            })
        }

        return eventType
    }

    private expressionTypeWithContext(expression: string, context: ExpressionContext) {
        let { expression: node, errorMessage: error } = parse(expression);
        if (error || !node) {
            return null;
        }
        else {
            return node.getType(context);
        }
    }

    private expressionValueWithContext(expression: string, context: ExpressionContext) {
        let { expression: node, errorMessage: error } = parse(expression);
        if (error || !node) {
            return null;
        }
        else {
            return node.compute(context);
        }
    }

    private propertyName(name: string, property: Property) {
        return `${property.ownerType !== Type.Global ? '(property) ' : ''}${property.ownerType && property.ownerType !== Type.Global ? property.ownerType.getName() + '.' : ''}${name}: ${property.type.getName()}`;
    }

    private methodName(name: string, method: Method, count: number) {
        let returnType = method.type ? method.type.getName() : 'void';
        return `${method.ownerType !== Type.Global ? '(method) ' : ''}${method.ownerType && method.ownerType !== Type.Global ? method.ownerType.getName() + '.' : ''}${name}(${(method.params || []).map(p => `${p.name}: ${p.type.getName()}`).join(', ')}): ${returnType}${count > 1 ? ` (+${count - 1} overload${count > 2 ? 's' : ''})` : ''}`
    }

    private findExpressionsInString(stringNode: json.Node): {
        string: JsonString,
        offset: number
    }[] {
        let position = this.document.positionAt(stringNode.offset);
        let rawString = this.document.getText(new vscode.Range(position, position.translate(0, stringNode.length)));
        if (rawString.startsWith("\"$:")) {
            return [{
                string: new JsonString(rawString.slice(3, -1)),
                offset: 3
            }];
        }
        const re = /\$\{(.*?)\}/mg;
        re.lastIndex = 0;
        let results = [];
        let match: RegExpExecArray;
        while (match = re.exec(rawString)) {
            results.push({
                string: new JsonString(match[1]),
                offset: match.index + 2
            });
        }
        return results;
    }

    private valueType(value: any) {
        if (value === null) return 'null';
        if (value instanceof Array) return 'array';
        return typeof(value);
    }

    private schemaSnippet(s: Schema): string {
        function schemaForType(type: string) {
            switch (type) {
                case 'string': return '"$0"';
                case 'object': return '{\n  $0\n}';
                case 'array': return '[\n  $0\n]';
                case 'null': return '${0:null}';
            }
            return '';
        }
        if (s && typeof(s) === 'object') {
            if (s.snippet) return s.snippet;
            if (s.oneOf) {
                let schemas = s.oneOf.filter(s => s && typeof(s) === 'object' && !s.deprecatedMessage);
                if (schemas.length === 1) {
                    return this.schemaSnippet(schemas[0]);
                }
                let set = [...new Set(s.oneOf.filter(s => s && typeof(s) === 'object' && !s.deprecatedMessage).map(s => this.schemaSnippet(s)))];
                if (set.length === 1) {
                    return set[0];
                }
                return '';
            }
            if (s.type === 'object' && s.required && s.required.length > 0) {
                let ret = `{
${s.required.map(p => `"${p}": ${this.schemaSnippet(s.properties[p]) || '$0'}`).join(',\n').split('\n').map(s => '  ' + s).join('\n')}
}`;
                var n = 0;
                ret = ret.replace(/\$\d+/mg, s => {
                    return `$${++n}`;
                })
                return ret;
            }
            if (s.type) return schemaForType(s.type);
            if (s.enum) {
                let set = [...new Set(s.enum.map(e => this.valueType(e)))];
                if (set.length === 1) {
                    return set[0];
                }
            }
        }
        return '';
    }

    private schemaEnums(s: Schema): [any, string, vscode.CompletionItemKind][] {
        if (s && typeof(s) === 'object') {
            if (s.enum) {
                let enums = s.enum;
                enums = enums.map((e, i) => [e, s.enumDescriptions ? s.enumDescriptions[i] : null, vscode.CompletionItemKind.EnumMember]);
                if (s.type) {
                    enums = enums.filter(e => this.valueType(e[0]) === s.type);
                }
                return enums;
            }
            else if (s.type) {
                switch (s.type) {
                    case 'boolean': return [[true, null, vscode.CompletionItemKind.Constant], [false, null, vscode.CompletionItemKind.Constant]];
                    case 'null': return [[null, null, vscode.CompletionItemKind.Constant]];
                }
            }
            else if (s.oneOf) {
                return s.oneOf.filter(s => s && typeof(s) === 'object' && !s.deprecatedMessage).map(s => this.schemaEnums(s)).reduce((p, c) => { p.push(...c); return p; }, []);
            }
        }
        return [];
    }

    private getDataType(obj: any): IType {
        if (obj instanceof IType) return obj;
        if (obj === undefined || obj === null) {
            return Type.Any;
        }
        let type = typeof(obj);
        if (type === 'string' || type === 'number' || type === 'boolean') {
            return Type.getType(type);
        }
        if (obj instanceof Array) {
            let ts = obj.map(o => this.getDataType(o));
            let objectTypes: ObjectType[] = ts.filter(t => t instanceof ObjectType) as ObjectType[];
            if (objectTypes.length >= 2) {
                let newObjectType = new ObjectType(objectTypes.reduce((p, c) => {
                    let map = c.getMap();
                    Object.keys(map).forEach(k => {
                        if (k in p) {
                            p[k] = IntersectionType.type([p[k], map[k]]);
                        }
                        else {
                            p[k] = map[k];
                        }
                    });
                    return p;
                }, {}));
                ts = ts.filter(t => !(t instanceof ObjectType));
                ts.push(newObjectType);
            }
            return new ArrayType(UnionType.type(ts));
        }
        return new ObjectType(Object.keys(obj).reduce((ret, k) => {ret[k] = this.getDataType(obj[k]); return ret}, {}));
    }

}