/*
 *
 * Copyright 2013 Anis Kadri
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
*/

var fs   = require('fs'),
    path = require('path'),
    glob = require('glob'),
    plist = require('plist'),
    bplist = require('bplist-parser'),
    et   = require('elementtree'),
    xml_helpers = require('./../util/xml-helpers'),
    plist_helpers = require('./../util/plist-helpers');

function checkPlatform(platform) {
    if (!(platform in require('./../platforms'))) throw new Error('platform "' + platform + '" not recognized.');
}

module.exports = {
    add_installed_plugin_to_prepare_queue:function(plugins_dir, plugin, platform, vars, is_top_level) {
        checkPlatform(platform);

        var config = module.exports.get_platform_json(plugins_dir, platform);
        config.prepare_queue.installed.push({'plugin':plugin, 'vars':vars, 'topLevel':is_top_level});
        module.exports.save_platform_json(config, plugins_dir, platform);
    },
    add_uninstalled_plugin_to_prepare_queue:function(plugins_dir, plugin, platform, is_top_level) {
        checkPlatform(platform);

        var plugin_xml = xml_helpers.parseElementtreeSync(path.join(plugins_dir, plugin, 'plugin.xml'));
        var config = module.exports.get_platform_json(plugins_dir, platform);
        config.prepare_queue.uninstalled.push({'plugin':plugin, 'id':plugin_xml._root.attrib['id'], 'topLevel':is_top_level});
        module.exports.save_platform_json(config, plugins_dir, platform);
    },
    get_platform_json:function(plugins_dir, platform) {
        checkPlatform(platform);

        var filepath = path.join(plugins_dir, platform + '.json'); 
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        } else {
            var config = {
                prepare_queue:{installed:[], uninstalled:[]},
                config_munge:{},
                installed_plugins:{},
                dependent_plugins:{}
            };
            fs.writeFileSync(filepath, JSON.stringify(config), 'utf-8');
            return config;
        }
    },
    save_platform_json:function(config, plugins_dir, platform) {
        checkPlatform(platform);

        var filepath = path.join(plugins_dir, platform + '.json'); 
        fs.writeFileSync(filepath, JSON.stringify(config), 'utf-8');
    },
    generate_plugin_config_munge:function(plugin_dir, platform, project_dir, vars) {
        checkPlatform(platform);

        vars = vars || {};
        var platform_handler = require('./../platforms')[platform];
        // Add PACKAGE_NAME variable into vars
        if (!vars['PACKAGE_NAME']) {
            vars['PACKAGE_NAME'] = platform_handler.package_name(project_dir);
        }

        var munge = {};
        var plugin_xml = xml_helpers.parseElementtreeSync(path.join(plugin_dir, 'plugin.xml'));

        var platformTag = plugin_xml.find('platform[@name="' + platform + '"]');
        var changes = [];
        // add platform-agnostic config changes
        changes = changes.concat(plugin_xml.findall('config-file'));
        if (platformTag) {
            // add platform-specific config changes if they exist
            changes = changes.concat(platformTag.findall('config-file'));

            // note down plugins-plist munges in special section of munge obj
            var plugins_plist = platformTag.findall('plugins-plist');
            plugins_plist.forEach(function(pl) {
                if (!munge['plugins-plist']) {
                    munge['plugins-plist'] = {};
                }
                var key = pl.attrib['key'];
                var value = pl.attrib['string'];
                if (!munge['plugins-plist'][key]) {
                    munge['plugins-plist'][key] = value;
                }
            });
        }

        changes.forEach(function(change) {
            var target = change.attrib['target'];
            var parent = change.attrib['parent'];
            if (!munge[target]) {
                munge[target] = {};
            }
            if (!munge[target][parent]) {
                munge[target][parent] = {};
            }
            var xmls = change.getchildren();
            xmls.forEach(function(xml) {
                // 1. stringify each xml
                var stringified = (new et.ElementTree(xml)).write({xml_declaration:false});
                // interp vars
                vars && Object.keys(vars).forEach(function(key) {
                    var regExp = new RegExp("\\$" + key, "g");
                    stringified = stringified.replace(regExp, vars[key]);
                });
                // 2. add into munge
                if (!munge[target][parent][stringified]) {
                    munge[target][parent][stringified] = 0;
                }
                munge[target][parent][stringified] += 1;
            });
        });
        return munge;
    },
    process:function(plugins_dir, project_dir, platform) {
        checkPlatform(platform);

        var platform_config = module.exports.get_platform_json(plugins_dir, platform);
        // Uninstallation first
        platform_config.prepare_queue.uninstalled.forEach(function(u) {
            var plugin_dir = path.join(plugins_dir, u.plugin);
            var plugin_id = u.id;
            var plugin_vars = (u.topLevel ? platform_config.installed_plugins[plugin_id] : platform_config.dependent_plugins[plugin_id]);

            // get config munge, aka how did this plugin change various config files
            var config_munge = module.exports.generate_plugin_config_munge(plugin_dir, platform, project_dir, plugin_vars);
            // global munge looks at all plugins' changes to config files
            var global_munge = platform_config.config_munge;
            
            // Traverse config munge and decrement global munge
            Object.keys(config_munge).forEach(function(file) {
                if (file == 'plugins-plist' && platform == 'ios') {
                    if (global_munge[file]) {
                        Object.keys(config_munge[file]).forEach(function(key) {
                            if (global_munge[file][key]) {
                                // prune from old plist if exists
                                var plistfile = glob.sync(path.join(project_dir, '**', '{PhoneGap,Cordova}.plist'));
                                if (plistfile.length > 0) {
                                    plistfile = plistfile[0];
                                    // determine if this is a binary or ascii plist and choose the parser
                                    // this is temporary until binary support is added to node-plist
                                    var pl = (isBinaryPlist(plistfile) ? bplist : plist);
                                    var plistObj = pl.parseFileSync(plistfile);
                                    delete plistObj.Plugins[key];
                                    fs.writeFileSync(plistfile, plist.build(plistObj));
                                }
                                delete global_munge[file][key];
                            }
                        });
                    }
                } else if (global_munge[file]) {
                    Object.keys(config_munge[file]).forEach(function(selector) {
                        if (global_munge[file][selector]) {
                            Object.keys(config_munge[file][selector]).forEach(function(xml_child) {
                                if (global_munge[file][selector][xml_child]) {
                                    global_munge[file][selector][xml_child] -= 1;
                                    if (global_munge[file][selector][xml_child] === 0) {
                                        // this xml child is no longer necessary, prune it
                                        // config.xml referenced in ios config changes refer to the project's config.xml, which we need to glob for.
                                        var filepath = resolveConfigFilePath(project_dir, platform, file);
                                        if (fs.existsSync(filepath)) {
                                            if (path.extname(filepath) == '.xml') {
                                                var xml_to_prune = [et.XML(xml_child)];
                                                var doc = xml_helpers.parseElementtreeSync(filepath);
                                                if (xml_helpers.pruneXML(doc, xml_to_prune, selector)) {
                                                    // were good, write out the file!
                                                    fs.writeFileSync(filepath, doc.write({indent: 4}), 'utf-8');
                                                } else {
                                                    // uh oh
                                                    throw new Error('pruning xml at selector "' + selector + '" from "' + filepath + '" during config uninstall went bad :(');
                                                }
                                            } else {
                                                // plist file
                                                var pl = (isBinaryPlist(filepath) ? bplist : plist);
                                                var plistObj = pl.parseFileSync(filepath);
                                                if (plist_helpers.prunePLIST(plistObj, xml_child, selector)) {
                                                    fs.writeFileSync(filepath, plist.build(plistObj));
                                                } else {
                                                    throw new Error('grafting to plist "' + filepath + '" during config install went bad :(');
                                                }
                                            }
                                        }
                                        delete global_munge[file][selector][xml_child];
                                    }
                                }
                            });
                        }
                    });
                }
            });
            platform_config.config_munge = global_munge;

            // Remove from installed_plugins
            if (u.topLevel) {
                delete platform_config.installed_plugins[plugin_id]
            } else {
                delete platform_config.dependent_plugins[plugin_id]
            }
        });

        // Empty out uninstalled queue.
        platform_config.prepare_queue.uninstalled = [];

        // Now handle instalation
        platform_config.prepare_queue.installed.forEach(function(u) {
            var plugin_dir = path.join(plugins_dir, u.plugin);
            var plugin_vars = u.vars;
            var plugin_id = xml_helpers.parseElementtreeSync(path.join(plugin_dir, 'plugin.xml'), 'utf-8')._root.attrib['id'];

            // get config munge, aka how should this plugin change various config files
            var config_munge = module.exports.generate_plugin_config_munge(plugin_dir, platform, project_dir, plugin_vars);
            // global munge looks at all plugins' changes to config files
            var global_munge = platform_config.config_munge;
            
            // Traverse config munge and decrement global munge
            Object.keys(config_munge).forEach(function(file) {
                if (!global_munge[file]) {
                    global_munge[file] = {};
                }
                Object.keys(config_munge[file]).forEach(function(selector) {
                    if (file == 'plugins-plist' && platform == 'ios') {
                        var key = selector;
                        if (!global_munge[file][key]) {
                            // this key does not exist, so add it to plist
                            global_munge[file][key] = config_munge[file][key];
                            var plistfile = glob.sync(path.join(project_dir, '**', '{PhoneGap,Cordova}.plist'));
                            if (plistfile.length > 0) {
                                plistfile = plistfile[0];
                                // determine if this is a binary or ascii plist and choose the parser
                                // this is temporary until binary support is added to node-plist
                                var pl = (isBinaryPlist(plistfile) ? bplist : plist);
                                var plistObj = pl.parseFileSync(plistfile);
                                plistObj.Plugins[key] = config_munge[file][key];
                                fs.writeFileSync(plistfile, plist.build(plistObj));
                            }
                        }
                    } else {
                        if (!global_munge[file][selector]) {
                            global_munge[file][selector] = {};
                        }
                        Object.keys(config_munge[file][selector]).forEach(function(xml_child) {
                            if (!global_munge[file][selector][xml_child]) {
                                global_munge[file][selector][xml_child] = 0;
                            }
                            global_munge[file][selector][xml_child] += 1;
                            if (global_munge[file][selector][xml_child] == 1) {
                                // this xml child is new, graft it (only if config file exists)
                                // config file may be in a place not exactly specified in the target
                                var filepath = resolveConfigFilePath(project_dir, platform, file);
                                if (fs.existsSync(filepath)) {
                                    // look at ext and do proper config change based on file type
                                    if (path.extname(filepath) == '.xml') {
                                        var xml_to_graft = [et.XML(xml_child)];
                                        var doc = xml_helpers.parseElementtreeSync(filepath);
                                        if (xml_helpers.graftXML(doc, xml_to_graft, selector)) {
                                            // were good, write out the file!
                                            fs.writeFileSync(filepath, doc.write({indent: 4}), 'utf-8');
                                        } else {
                                            // uh oh
                                            throw new Error('grafting xml at selector "' + selector + '" from "' + filepath + '" during config install went bad :(');
                                        }
                                    } else {
                                        // plist file
                                        var pl = (isBinaryPlist(filepath) ? bplist : plist);
                                        var plistObj = pl.parseFileSync(filepath);
                                        if (plist_helpers.graftPLIST(plistObj, xml_child, selector)) {
                                            fs.writeFileSync(filepath, plist.build(plistObj));
                                        } else {
                                            throw new Error('grafting to plist "' + filepath + '" during config install went bad :(');
                                        }
                                    }
                                }
                            }
                        });
                    }
                });
            });
            platform_config.config_munge = global_munge;

            // Move to installed_plugins if it is a top-level plugin
            if (u.topLevel) {
                platform_config.installed_plugins[plugin_id] = plugin_vars || {};
            } else {
                platform_config.dependent_plugins[plugin_id] = plugin_vars || {};
            }
        });

        // Empty out installed queue.
        platform_config.prepare_queue.installed = [];

        // save
        module.exports.save_platform_json(platform_config, plugins_dir, platform);
    }
};

// determine if a plist file is binary
function isBinaryPlist(filename) {
    // I wish there was a synchronous way to read only the first 6 bytes of a
    // file. This is wasteful :/ 
    var buf = '' + fs.readFileSync(filename, 'utf8');
    // binary plists start with a magic header, "bplist"
    return buf.substring(0, 6) === 'bplist';
}

// Some config-file target attributes are not qualified with a full leading directory, or contain wildcards. resolve to a real path in this function
function resolveConfigFilePath(project_dir, platform, file) {
    var filepath = path.join(project_dir, file);
    if (file.indexOf('*') > -1) {
        // handle wildcards in targets using glob.
        var matches = glob.sync(path.join(project_dir, '**', file));
        if (matches.length) filepath = matches[0];
    } else {
        // special-case config.xml target that is just "config.xml". this should be resolved to the real location of the file.
        if (file == 'config.xml') {
            var matches = glob.sync(path.join(project_dir, '**', 'config.xml'));
            if (matches.length) filepath = matches[0];
        }
    }
    return filepath;
}
