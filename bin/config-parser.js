exports.parse = function(fname, callback) {
    require('fs').readFile(fname, 'utf8', function(err, config) {
        if (err) {
            return callback(err);
        }

        var result = {
            modifiers: [],
            rules: [],
            sections: []
        };
        var currentSection;
        var currentRule;
        var skiping = false;
        config.split('\n').forEach(function(line) {
            line = line.trim();
            if (line && line.indexOf('#') != 0) {
                if (line.indexOf('[') == 0 && line.indexOf(']') == line.length - 1) {
                    var sectionName = line.slice(1, -1).trim();
                    skiping = sectionName.indexOf('#') == 0;
                    currentSection = {
                        modifiers: [],
                        rules: []
                    };
                    result.sections.push(currentSection);
                    currentRule = null;
                } else if (!skiping) {
                    if (line.indexOf('$') == 0) {
                        var modifier = createModifier(line.slice(1));
                        if (modifier) {
                            (currentRule || currentSection || result).modifiers.push(modifier);
                        }
                    } else if (line.indexOf('=>') > -1) {
                        var operands = line.split('=>').map(function(operand) {
                            return operand.trim();
                        });
                        var pattern = createPattern(operands[0]);
                        currentRule = {
                            pattern: pattern,
                            action: createAction(pattern.url || pattern.urlStart, operands[1]) ,
                            modifiers: []
                        };
                        (currentSection || result).rules.push(currentRule);
                    }

                }
            }
        });
        callback(null, result);
    });
};

function createPattern(source) {
    if (source[0] == '/' && source[source.length - 1] == '/') {
        return {
            url: new RegExp(source.substr(1, source.length - 2), 'i')
        };
    } else if (source[0] == '!') {
        return {
            url: source.slice(1).replace(/^(?!https?:\/\/)/, 'http://')
        };
    } else {
        return {
            urlStart: source.replace(/^(?!https?:\/\/)/, 'http://')
        };
    }
}

function createAction(pattern, replacement) {
    if (replacement == '$') {
        return createDefaultAction();
    } else if (replacement == '') {
        return createAbortAction();
    } else if (replacement.match(/^data:(?:([a-zA-Z/-]+);)?(base64,)?(.*)/)) {
        return createDataAction(pattern, RegExp.$3 || '', RegExp.$1 || 'text/plain', !!RegExp.$2);
    } else if (replacement.indexOf('file://') == 0) {
        return createFileAction(pattern, replacement.slice(7));
    } else if (replacement.indexOf('proxy:') == 0) {
        return createProxyAction(replacement.slice(6).trim())
    } else if (replacement.indexOf('bin:') == 0) {
        return createBinAction(pattern, replacement.slice(4).trim());
    } else if (replacement.indexOf('eval:') == 0) {
        return createEvalAction(pattern, replacement.slice(5).trim());
    } else {
        return createStandardAction(pattern, replacement);
    }
}

function createDefaultAction() {
    return function(state) {
        state.doRequest();
    };
}

function createAbortAction() {
    return function(state) {
        state.abort();
    };
}

function createDataAction(pattern, tpl, contentType, isBase64) {
    return function(state) {
        var content = tpl;
        if (!isBase64) {
            content = applyTemplate(tpl, state, pattern);
        }
        content = new Buffer(content, isBase64 ? 'base64' : 'utf8');
        state.setResponseType(contentType);
        state.send(content);
    };
}

function createFileAction(pattern, fnameTemplate) {
    return function(state) {
        var tpl = fnameTemplate;
        if (typeof pattern == 'string') {
            tpl = require('path').join(tpl, state.getRequestUrl().slice(pattern.length));
        }
        var fname = applyTemplate(tpl, state, pattern).split('?')[0];
        fname = fname.replace(/~/g, state.get('documentRoot', ''));
        state.sendFile(fname);
    };
}

function createProxyAction(proxyParam) {
    if (proxyParam && proxyParam.match(/^(?:([^:]*):([^@]*)@)?([^:]*):([0-9]*)$/)) {
        var proxy = {
            user: RegExp.$1,
            password: RegExp.$2,
            host: RegExp.$3,
            port: RegExp.$4
        };
    }
    return function(state) {
        state.setProxy(proxy);
        state.doRequest();
    };
}

function createBinAction(pattern, commandTpl) {
    return function(state) {
        var command = applyTemplate(commandTpl, state, pattern);
        require('child_process').exec(command, {encoding: 'binary'}, function(err, stdout, stderr) {
            if (err) {
                return state.error(err);
            }
            state.send(stdout || stderr);
        });
    };
}

function createEvalAction(pattern, commandTpl) {
    return function(state) {
        var command = applyTemplate(commandTpl, state, pattern);
        state.doRequest({data_eval:command});
    };
}

function createStandardAction(pattern, urlTemplate) {
    return function(state) {
        var tpl = urlTemplate;
        if (typeof pattern == 'string') {
            tpl = tpl.replace(/^(?!https?:\/\/)/, 'http://') + state.getRequestUrl().slice(pattern.length);
        }
        var url = applyTemplate(tpl, state, pattern);
        state.setRequestUrl(url);
        state.doRequest();
    };
}

function applyTemplate(tpl, state, pattern) {
    var args = [];
    if (typeof pattern != 'string') {
        args = state.getRequestUrl().match(pattern);
    }
    return tpl.replace(/(?:(~)|\$(?:(\d+)|\{(&)?([^}]+)\}))/g, function(ignore, tilde, num, escape, varname) {
        if (tilde) {
            return state.get('documentRoot');
        } else if (num) {
            return args[num] || '';
        } else {
            var result = '';
            var method = {
                url: 'getRequestUrl',
                host: 'getRequestHost',
                port: 'getRequestPort',
                path: 'getRequestPath',
                query: 'getQueryString'
            }[varname];
            if (method) {
                result = state[method]();
            } else if (varname.indexOf('header:') == 0) {
                result = state.getRequestHeader(varname.slice(7));
            } else if (varname.indexOf('param:') == 0) {
                result = state.getQueryParam(varname.slice(6));
            } else if (varname.indexOf('cookie:')) {
                result = state.getCookie(varname.slice(7));
            }
            if (escape) {
                result = encodeURIComponent(result);
            }
            return result;
        }
    });
}

function createModifier(command) {
    var args = command.split(/\s+/);
    var commandName = args.shift();
    var methodName = commandName[0].toLowerCase() + commandName.slice(1);
    var commandArg = args.join(' ');
    if (/^(SetRequestHeader|SetResponseHeader|SetQueryParam|SetCookie)$/.test(commandName)) {
        var argsSeparator = ':';
        if (commandName == 'SetQueryParam' || commandName == 'SetCookie') {
            argsSeparator = '=';
        }
        var setArgs = commandArg.split(argsSeparator);
        var setArgName = setArgs.shift().trim();
        var setArgValue = setArgs.join(argsSeparator).trim();
        return function(state) {
            state[methodName](setArgName, applyTemplate(setArgValue, state, ''));
        };
    }
    if (/^(RemoveRequestHeader|RemoveResponseHeader|RemoveQueryParam|RemoveCookie)$/.test(commandName)) {
        return function(state) {
            state[methodName](commandArg);
        };
    }
    if (commandName == 'StatusCode') {
        var statusCode = +commandArg;
        if (statusCode) {
            return function(state) {
                state.overwriteResponseStatus(statusCode);
            };
        }
    }
    if (commandName == 'Delay') {
        var timeout = +commandArg;
        if (timeout) {
            return function(state) {
                state.set('delay', timeout);
            };
        }
    }

    if (commandName == 'SetDocumentRoot') {
        var documentRoot = commandArg;
        return function(state) {
            state.set('documentRoot', applyTemplate(documentRoot, state, ''));
        };
    }

    console.log('Unknown modifier ' + commandName);
}
