/**
* @description MeshCentral MeshAgent communication module
* @author Ylian Saint-Hilaire & Bryan Roe
* @copyright Intel Corporation 2018-2019
* @license Apache-2.0
* @version v0.0.1
*/

/*xjslint node: true */
/*xjslint plusplus: true */
/*xjslint maxlen: 256 */
/*jshint node: true */
/*jshint strict: false */
/*jshint esversion: 6 */
"use strict";

// Construct a MeshAgent object, called upon connection
module.exports.CreateMeshAgent = function (parent, db, ws, req, args, domain) {
    const forge = parent.parent.certificateOperations.forge;
    const common = parent.parent.common;
    const agentUpdateBlockSize = 65531;

    var obj = {};
    obj.domain = domain;
    obj.authenticated = 0;
    obj.receivedCommands = 0;
    obj.agentCoreCheck = 0;
    obj.remoteaddr = (req.ip.startsWith('::ffff:')) ? (req.ip.substring(7)) : req.ip;
    obj.remoteaddrport = obj.remoteaddr + ':' + ws._socket.remotePort;
    obj.nonce = parent.crypto.randomBytes(48).toString('binary');
    ws._socket.setKeepAlive(true, 240000); // Set TCP keep alive, 4 minutes
    //obj.nodeid = null;
    //obj.meshid = null;
    //obj.dbNodeKey = null;
    //obj.dbMeshKey = null;
    //obj.connectTime = null;
    //obj.agentInfo = null;

    // Send a message to the mesh agent
    obj.send = function (data, func) { try { if (typeof data == 'string') { ws.send(Buffer.from(data, 'binary'), func); } else { ws.send(data, func); } } catch (e) { } };

    // Disconnect this agent
    obj.close = function (arg) {
        obj.authenticated = -1;
        if ((arg == 1) || (arg == null)) { try { ws.close(); if (obj.nodeid != null) { parent.parent.debug(1, 'Soft disconnect ' + obj.nodeid + ' (' + obj.remoteaddrport + ')'); } } catch (e) { console.log(e); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); if (obj.nodeid != null) { parent.parent.debug(1, 'Hard disconnect ' + obj.nodeid + ' (' + obj.remoteaddrport + ')'); } } catch (e) { console.log(e); } } // Hard close, close the TCP socket
        // If arg == 3, don't communicate with this agent anymore, but don't disconnect (Duplicate agent).

        // Remove this agent from the webserver list
        if (parent.wsagents[obj.dbNodeKey] == obj) {
            delete parent.wsagents[obj.dbNodeKey];
            parent.parent.ClearConnectivityState(obj.dbMeshKey, obj.dbNodeKey, 1);
        }

        // Get the current mesh
        const mesh = parent.meshes[obj.dbMeshKey];

        // If this is a temporary or recovery agent, or all devices in this group are temporary, remove the agent (0x20 = Temporary, 0x40 = Recovery)
        if (((obj.agentInfo) && (obj.agentInfo.capabilities) && ((obj.agentInfo.capabilities & 0x20) || (obj.agentInfo.capabilities & 0x40))) || ((mesh) && (mesh.flags) && (mesh.flags & 1))) {
            // Delete this node including network interface information and events
            db.Remove(obj.dbNodeKey);                       // Remove node with that id
            db.Remove('if' + obj.dbNodeKey);                // Remove interface information
            db.Remove('nt' + obj.dbNodeKey);                // Remove notes
            db.Remove('lc' + obj.dbNodeKey);                // Remove last connect time
            db.RemoveSMBIOS(obj.dbNodeKey);                 // Remove SMBios data
            db.RemoveAllNodeEvents(obj.dbNodeKey);          // Remove all events for this node
            db.removeAllPowerEventsForNode(obj.dbNodeKey);  // Remove all power events for this node

            // Event node deletion
            parent.parent.DispatchEvent(['*', obj.dbMeshKey], obj, { etype: 'node', action: 'removenode', nodeid: obj.dbNodeKey, domain: domain.id, nolog: 1 });

            // Disconnect all connections if needed
            const state = parent.parent.GetConnectivityState(obj.dbNodeKey);
            if ((state != null) && (state.connectivity != null)) {
                if ((state.connectivity & 1) != 0) { parent.wsagents[obj.dbNodeKey].close(); } // Disconnect mesh agent
                if ((state.connectivity & 2) != 0) { parent.parent.mpsserver.close(parent.parent.mpsserver.ciraConnections[obj.dbNodeKey]); } // Disconnect CIRA connection
            }
        } else {
            // Update the last connect time
            if (obj.authenticated == 2) { db.Set({ _id: 'lc' + obj.dbNodeKey, type: 'lastconnect', domain: domain.id, time: obj.connectTime, addr: obj.remoteaddrport }); }
        }

        // If we where updating the agent, clean that up.
        if (obj.agentUpdate != null) {
            if (obj.agentUpdate.fd) { try { parent.fs.close(obj.agentUpdate.fd); } catch (ex) { } }
            parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
            delete obj.agentUpdate.buf;
            delete obj.agentUpdate;
        }

        // Perform aggressive cleanup
        if (obj.nonce) { delete obj.nonce; }
        if (obj.nodeid) { delete obj.nodeid; }
        if (obj.unauth) { delete obj.unauth; }
        if (obj.remoteaddr) { delete obj.remoteaddr; }
        if (obj.remoteaddrport) { delete obj.remoteaddrport; }
        if (obj.meshid) { delete obj.meshid; }
        if (obj.dbNodeKey) { delete obj.dbNodeKey; }
        if (obj.dbMeshKey) { delete obj.dbMeshKey; }
        if (obj.connectTime) { delete obj.connectTime; }
        if (obj.agentInfo) { delete obj.agentInfo; }
        if (obj.agentExeInfo) { delete obj.agentExeInfo; }
        ws.removeAllListeners(["message", "close", "error"]);
    };

    // When data is received from the mesh agent web socket
    ws.on('message', function (msg) {
        if (msg.length < 2) return;
        if (typeof msg == 'object') { msg = msg.toString('binary'); } // TODO: Could change this entire method to use Buffer instead of binary string

        if (obj.authenticated == 2) { // We are authenticated
            if ((obj.agentUpdate == null) && (msg.charCodeAt(0) == 123)) { processAgentData(msg); } // Only process JSON messages if meshagent update is not in progress
            if (msg.length < 2) return;
            const cmdid = common.ReadShort(msg, 0);
            if (cmdid == 11) { // MeshCommand_CoreModuleHash
                if (msg.length == 4) { ChangeAgentCoreInfo({ "caps": 0 }); } // If the agent indicated that no core is running, clear the core information string.
                // Mesh core hash, sent by agent with the hash of the current mesh core.

                // If we are using a custom core, don't try to update it.
                if (obj.agentCoreCheck == 1000) {
                    obj.send(common.ShortToStr(16) + common.ShortToStr(0)); // MeshCommand_CoreOk. Indicates to the agent that the core is ok. Start it if it's not already started.
                    agentCoreIsStable();
                    return;
                }

                // Get the current meshcore hash
                const agentMeshCoreHash = (msg.length == 52) ? msg.substring(4, 52) : null;

                // If the agent indicates this is a custom core, we are done.
                if ((agentMeshCoreHash != null) && (agentMeshCoreHash == '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0')) {
                    obj.agentCoreCheck = 0;
                    obj.send(common.ShortToStr(16) + common.ShortToStr(0)); // MeshCommand_CoreOk. Indicates to the agent that the core is ok. Start it if it's not already started.
                    agentCoreIsStable();
                    return;
                }

                // We need to check if the core is current. Figure out what core we need.
                var corename;
                if (obj.agentCoreCheck == 1001) {
                    // If the user asked, use the recovery core.
                    corename = parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].rcore;
                } else if (obj.agentInfo.capabilities & 0x40) {
                    // If this is a recovery agent, use the agent recovery core.
                    corename = parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].arcore;
                } else {
                    // This is the normal core for this agent type.
                    corename = parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].core;
                }

                // If we have a core, use it.
                if (corename != null) {
                    const meshcorehash = parent.parent.defaultMeshCoresHash[corename];
                    if (agentMeshCoreHash != meshcorehash) {
                        if ((obj.agentCoreCheck < 5) || (obj.agentCoreCheck == 1001)) {
                            if (meshcorehash == null) {
                                // Clear the core
                                obj.send(common.ShortToStr(10) + common.ShortToStr(0)); // MeshCommand_CoreModule, ask mesh agent to clear the core
                                parent.parent.debug(1, 'Clearing core');
                            } else {
                                // Update new core
                                //obj.send(common.ShortToStr(10) + common.ShortToStr(0) + meshcorehash + parent.parent.defaultMeshCores[corename]); // MeshCommand_CoreModule, start core update
                                //parent.parent.debug(1, 'Updating code ' + corename);

                                // Update new core with task limiting so not to flood the server. This is a high priority task.
                                obj.agentCoreUpdatePending = true;
                                parent.parent.taskLimiter.launch(function (argument, taskid, taskLimiterQueue) {
                                    if (obj.authenticated == 2) {
                                        // Send the updated code.
                                        delete obj.agentCoreUpdatePending;
                                        obj.send(common.ShortToStr(10) + common.ShortToStr(0) + argument.hash + argument.core, function () { parent.parent.taskLimiter.completed(taskid); }); // MeshCommand_CoreModule, start core update
                                        parent.parent.debug(1, 'Updating code ' + argument.name);
                                        agentCoreIsStable();
                                    } else {
                                        // This agent is probably disconnected, nothing to do.
                                        parent.parent.taskLimiter.completed(taskid);
                                    }
                                }, { hash: meshcorehash, core: parent.parent.defaultMeshCores[corename], name: corename }, 0);
                            }
                            obj.agentCoreCheck++;
                        }
                    } else {
                        obj.agentCoreCheck = 0;
                        obj.send(common.ShortToStr(16) + common.ShortToStr(0)); // MeshCommand_CoreOk. Indicates to the agent that the core is ok. Start it if it's not already started.
                        agentCoreIsStable(); // No updates needed, agent is ready to go.
                    }
                }

                /*
                // TODO: Check if we have a mesh specific core. If so, use that.
                var agentMeshCoreHash = null;
                if (msg.length == 52) { agentMeshCoreHash = msg.substring(4, 52); }
                if ((agentMeshCoreHash != parent.parent.defaultMeshCoreHash) && (agentMeshCoreHash != parent.parent.defaultMeshCoreNoMeiHash)) {
                    if (obj.agentCoreCheck < 5) { // This check is in place to avoid a looping core update.
                        if (parent.parent.defaultMeshCoreHash == null) {
                            // Update no core
                            obj.send(common.ShortToStr(10) + common.ShortToStr(0)); // Command 10, ask mesh agent to clear the core
                        } else {
                            // Update new core
                            if (parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].amt == true) {
                                obj.send(common.ShortToStr(10) + common.ShortToStr(0) + parent.parent.defaultMeshCoreHash + parent.parent.defaultMeshCore); // Command 10, ask mesh agent to set the core (with MEI support)
                            } else {
                                obj.send(common.ShortToStr(10) + common.ShortToStr(0) + parent.parent.defaultMeshCoreNoMeiHash + parent.parent.defaultMeshCoreNoMei); // Command 10, ask mesh agent to set the core (No MEI)
                            }
                        }
                        obj.agentCoreCheck++;
                    }
                } else {
                    obj.agentCoreCheck = 0;
                }
                */
            }
            else if (cmdid == 12) { // MeshCommand_AgentHash
                if ((msg.length == 52) && (obj.agentExeInfo != null) && (obj.agentExeInfo.update == true)) {
                    const agenthash = msg.substring(4);
                    if ((agenthash != obj.agentExeInfo.hash) && (agenthash != '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0')) {
                        // Mesh agent update required, do it using task limiter so not to flood the network. Medium priority task.
                        parent.parent.taskLimiter.launch(function (argument, taskid, taskLimiterQueue) {
                            if (obj.authenticated != 2) { parent.parent.taskLimiter.completed(taskid); return; } // If agent disconnection, complete and exit now.
                            if (obj.nodeid != null) { parent.parent.debug(1, 'Agent update required, NodeID=0x' + obj.nodeid.substring(0, 16) + ', ' + obj.agentExeInfo.desc); }
                            if (obj.agentExeInfo.data == null) {
                                // Read the agent from disk
                                parent.fs.open(obj.agentExeInfo.path, 'r', function (err, fd) {
                                    if (obj.agentExeInfo == null) return; // Agent disconnected during this call.
                                    if (err) { return console.error(err); }
                                    obj.agentUpdate = { ptr: 0, buf: Buffer.alloc(agentUpdateBlockSize + 4), fd: fd, taskid: taskid };

                                    // MeshCommand_CoreModule, ask mesh agent to clear the core.
                                    // The new core will only be sent after the agent updates.
                                    obj.send(common.ShortToStr(10) + common.ShortToStr(0));

                                    // We got the agent file open on the server side, tell the agent we are sending an update starting with the SHA384 hash of the result
                                    //console.log("Agent update file open.");
                                    obj.send(common.ShortToStr(13) + common.ShortToStr(0)); // Command 13, start mesh agent download

                                    // Send the first mesh agent update data block
                                    obj.agentUpdate.buf[0] = 0;
                                    obj.agentUpdate.buf[1] = 14;
                                    obj.agentUpdate.buf[2] = 0;
                                    obj.agentUpdate.buf[3] = 1;
                                    parent.fs.read(obj.agentUpdate.fd, obj.agentUpdate.buf, 4, agentUpdateBlockSize, obj.agentUpdate.ptr, function (err, bytesRead, buffer) {
                                        if ((err != null) || (bytesRead == 0)) {
                                            // Error reading the agent file, stop here.
                                            try { parent.fs.close(obj.agentUpdate.fd); } catch (ex) { }
                                            parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
                                            delete obj.agentUpdate.buf;
                                            delete obj.agentUpdate;
                                        } else {
                                            // Send the first block to the agent
                                            obj.agentUpdate.ptr += bytesRead;
                                            //console.log("Agent update send first block: " + bytesRead);
                                            obj.send(obj.agentUpdate.buf); // Command 14, mesh agent first data block
                                        }
                                    });
                                });
                            } else {
                                // Send the agent from RAM
                                obj.agentUpdate = { ptr: 0, buf: Buffer.alloc(agentUpdateBlockSize + 4), taskid: taskid };

                                // MeshCommand_CoreModule, ask mesh agent to clear the core.
                                // The new core will only be sent after the agent updates.
                                obj.send(common.ShortToStr(10) + common.ShortToStr(0));

                                // We got the agent file open on the server side, tell the agent we are sending an update starting with the SHA384 hash of the result
                                obj.send(common.ShortToStr(13) + common.ShortToStr(0)); // Command 13, start mesh agent download

                                // Send the first mesh agent update data block
                                obj.agentUpdate.buf[0] = 0;
                                obj.agentUpdate.buf[1] = 14;
                                obj.agentUpdate.buf[2] = 0;
                                obj.agentUpdate.buf[3] = 1;

                                const len = Math.min(agentUpdateBlockSize, obj.agentExeInfo.data.length - obj.agentUpdate.ptr);
                                if (len > 0) {
                                    // Send the first block
                                    obj.agentExeInfo.data.copy(obj.agentUpdate.buf, 4, obj.agentUpdate.ptr, obj.agentUpdate.ptr + len);
                                    obj.agentUpdate.ptr += len;
                                    obj.send(obj.agentUpdate.buf); // Command 14, mesh agent first data block
                                } else {
                                    // Error
                                    parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
                                    delete obj.agentUpdate.buf;
                                    delete obj.agentUpdate;
                                }
                            }
                        }, null, 1);

                    } else {
                        // Check the mesh core, if the agent is capable of running one
                        if (((obj.agentInfo.capabilities & 16) != 0) && (parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].core != null)) {
                            obj.send(common.ShortToStr(11) + common.ShortToStr(0)); // Command 11, ask for mesh core hash.
                        }
                    }
                }
            }
            else if (cmdid == 14) { // MeshCommand_AgentBinaryBlock
                if ((msg.length == 4) && (obj.agentUpdate != null)) {
                    const status = common.ReadShort(msg, 2);
                    if (status == 1) {
                        if (obj.agentExeInfo.data == null) {
                            // Read the agent from disk
                            parent.fs.read(obj.agentUpdate.fd, obj.agentUpdate.buf, 4, agentUpdateBlockSize, obj.agentUpdate.ptr, function (err, bytesRead, buffer) {
                                if ((obj.agentExeInfo == null) || (obj.agentUpdate == null)) return; // Agent disconnected during this async call.
                                if ((err != null) || (bytesRead < 0)) {
                                    // Error reading the agent file, stop here.
                                    try { parent.fs.close(obj.agentUpdate.fd); } catch (ex) { }
                                    parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
                                    delete obj.agentUpdate.buf;
                                    delete obj.agentUpdate;
                                } else {
                                    // Send the next block to the agent
                                    obj.agentUpdate.ptr += bytesRead;
                                    //console.log("Agent update send next block", obj.agentUpdate.ptr, bytesRead);
                                    if (bytesRead == agentUpdateBlockSize) { obj.send(obj.agentUpdate.buf); } else { obj.send(obj.agentUpdate.buf.slice(0, bytesRead + 4)); } // Command 14, mesh agent next data block
                                    if (bytesRead < agentUpdateBlockSize) {
                                        //console.log("Agent update sent from disk.");
                                        obj.send(common.ShortToStr(13) + common.ShortToStr(0) + obj.agentExeInfo.hash); // Command 13, end mesh agent download, send agent SHA384 hash
                                        try { parent.fs.close(obj.agentUpdate.fd); } catch (ex) { }
                                        parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
                                        delete obj.agentUpdate.buf;
                                        delete obj.agentUpdate;
                                    }
                                }
                            });
                        } else {
                            // Send the agent from RAM
                            const len = Math.min(agentUpdateBlockSize, obj.agentExeInfo.data.length - obj.agentUpdate.ptr);
                            if (len > 0) {
                                obj.agentExeInfo.data.copy(obj.agentUpdate.buf, 4, obj.agentUpdate.ptr, obj.agentUpdate.ptr + len);
                                if (len == agentUpdateBlockSize) { obj.send(obj.agentUpdate.buf); } else { obj.send(obj.agentUpdate.buf.slice(0, len + 4)); } // Command 14, mesh agent next data block
                                obj.agentUpdate.ptr += len;
                            }

                            if (obj.agentUpdate.ptr == obj.agentExeInfo.data.length) {
                                //console.log("Agent update sent from RAM.");
                                obj.send(common.ShortToStr(13) + common.ShortToStr(0) + obj.agentExeInfo.hash); // Command 13, end mesh agent download, send agent SHA384 hash
                                parent.parent.taskLimiter.completed(obj.agentUpdate.taskid); // Indicate this task complete
                                delete obj.agentUpdate.buf;
                                delete obj.agentUpdate;
                            }
                        }
                    }
                }
            }
            else if (cmdid == 15) { // MeshCommand_AgentTag
                var tag = msg.substring(2);
                while (tag.charCodeAt(tag.length - 1) == 0) { tag = tag.substring(0, tag.length - 1); } // Remove end-of-line zeros.
                ChangeAgentTag(tag);
            }
        } else if (obj.authenticated < 2) { // We are not authenticated
            const cmd = common.ReadShort(msg, 0);
            if (cmd == 1) {
                // Agent authentication request
                if ((msg.length != 98) || ((obj.receivedCommands & 1) != 0)) return;
                obj.receivedCommands += 1; // Agent can't send the same command twice on the same connection ever. Block DOS attack path.

                if (args.ignoreagenthashcheck === true) {
                    // Send the agent web hash back to the agent
                    obj.send(common.ShortToStr(1) + msg.substring(2, 50) + obj.nonce); // Command 1, hash + nonce. Use the web hash given by the agent.
                } else {
                    // Check that the server hash matches our own web certificate hash (SHA384)
                    if ((getWebCertHash(domain) != msg.substring(2, 50)) && (getWebCertFullHash(domain) != msg.substring(2, 50))) {
                        console.log('Agent bad web cert hash (Agent:' + (Buffer.from(msg.substring(2, 50), 'binary').toString('hex').substring(0, 10)) + ' != Server:' + (Buffer.from(getWebCertHash(domain), 'binary').toString('hex').substring(0, 10)) + ' or ' + (new Buffer(getWebCertFullHash(domain), 'binary').toString('hex').substring(0, 10)) + '), holding connection (' + obj.remoteaddrport + ').');
                        console.log('Agent reported web cert hash:' + (Buffer.from(msg.substring(2, 50), 'binary').toString('hex')) + '.');
                        return;
                    }
                }

                // Use our server private key to sign the ServerHash + AgentNonce + ServerNonce
                obj.agentnonce = msg.substring(50, 98);

                // Check if we got the agent auth confirmation
                if ((obj.receivedCommands & 8) == 0) {
                    // If we did not get an indication that the agent already validated this server, send the server signature.
                    if (obj.useSwarmCert == true) {
                        // Perform the hash signature using older swarm server certificate
                        parent.parent.certificateOperations.acceleratorPerformSignature(1, msg.substring(2) + obj.nonce, obj, function (obj2, signature) {
                            // Send back our certificate + signature
                            obj2.send(common.ShortToStr(2) + common.ShortToStr(parent.swarmCertificateAsn1.length) + parent.swarmCertificateAsn1 + signature); // Command 2, certificate + signature
                        });
                    } else {
                        // Perform the hash signature using the server agent certificate
                        parent.parent.certificateOperations.acceleratorPerformSignature(0, msg.substring(2) + obj.nonce, obj, function (obj2, signature) {
                            // Send back our certificate + signature
                            obj2.send(common.ShortToStr(2) + common.ShortToStr(parent.agentCertificateAsn1.length) + parent.agentCertificateAsn1 + signature); // Command 2, certificate + signature
                        });
                    }
                }

                // Check the agent signature if we can
                if (obj.unauthsign != null) {
                    if (processAgentSignature(obj.unauthsign) == false) { console.log('Agent connected with bad signature, holding connection (' + obj.remoteaddrport + ').'); return; } else { completeAgentConnection(); }
                }
            }
            else if (cmd == 2) {
                // Agent certificate
                if ((msg.length < 4) || ((obj.receivedCommands & 2) != 0)) return;
                obj.receivedCommands += 2; // Agent can't send the same command twice on the same connection ever. Block DOS attack path.

                // Decode the certificate
                const certlen = common.ReadShort(msg, 2);
                obj.unauth = {};
                try { obj.unauth.nodeid = Buffer.from(forge.pki.getPublicKeyFingerprint(forge.pki.certificateFromAsn1(forge.asn1.fromDer(msg.substring(4, 4 + certlen))).publicKey, { md: forge.md.sha384.create() }).data, 'binary').toString('base64').replace(/\+/g, '@').replace(/\//g, '$'); } catch (ex) { console.log(ex); return; }
                obj.unauth.nodeCertPem = '-----BEGIN CERTIFICATE-----\r\n' + Buffer.from(msg.substring(4, 4 + certlen), 'binary').toString('base64') + '\r\n-----END CERTIFICATE-----';

                // Check the agent signature if we can
                if (obj.agentnonce == null) { obj.unauthsign = msg.substring(4 + certlen); } else { if (processAgentSignature(msg.substring(4 + certlen)) == false) { console.log('Agent connected with bad signature, holding connection (' + obj.remoteaddrport + ').'); return; } }
                completeAgentConnection();
            }
            else if (cmd == 3) {
                // Agent meshid
                if ((msg.length < 72) || ((obj.receivedCommands & 4) != 0)) return;
                obj.receivedCommands += 4; // Agent can't send the same command twice on the same connection ever. Block DOS attack path.

                // Set the meshid
                obj.agentInfo = {};
                obj.agentInfo.infoVersion = common.ReadInt(msg, 2);
                obj.agentInfo.agentId = common.ReadInt(msg, 6);
                obj.agentInfo.agentVersion = common.ReadInt(msg, 10);
                obj.agentInfo.platformType = common.ReadInt(msg, 14);
                if (obj.agentInfo.platformType > 6 || obj.agentInfo.platformType < 1) { obj.agentInfo.platformType = 1; }
                if (msg.substring(50, 66) == '\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0') {
                    obj.meshid = Buffer.from(msg.substring(18, 50), 'binary').toString('hex'); // Older HEX MeshID
                } else {
                    obj.meshid = Buffer.from(msg.substring(18, 66), 'binary').toString('base64').replace(/\+/g, '@').replace(/\//g, '$'); // New Base64 MeshID
                }
                //console.log('MeshID', obj.meshid);
                obj.agentInfo.capabilities = common.ReadInt(msg, 66);
                const computerNameLen = common.ReadShort(msg, 70);
                obj.agentInfo.computerName = msg.substring(72, 72 + computerNameLen);
                obj.dbMeshKey = 'mesh/' + domain.id + '/' + obj.meshid;
                completeAgentConnection();
            } else if (cmd == 4) {
                if ((msg.length < 2) || ((obj.receivedCommands & 8) != 0)) return;
                obj.receivedCommands += 8; // Agent can't send the same command twice on the same connection ever. Block DOS attack path.
                // Agent already authenticated the server, wants to skip the server signature - which is great for server performance.
            } else if (cmd == 5) {
                // ServerID. Agent is telling us what serverid it expects. Useful if we have many server certificates.
                if ((msg.substring(2, 34) == parent.swarmCertificateHash256) || (msg.substring(2, 50) == parent.swarmCertificateHash384)) { obj.useSwarmCert = true; }
            }
        }
    });

    // If error, do nothing
    ws.on('error', function (err) { console.log('AGENT WSERR: ' + err); obj.close(0); });

    // If the mesh agent web socket is closed, clean up.
    ws.on('close', function (req) {
        if (obj.nodeid != null) {
            const agentId = (obj.agentInfo && obj.agentInfo.agentId) ? obj.agentInfo.agentId : 'Unknown';
            //console.log('Agent disconnect ' + obj.nodeid + ' (' + obj.remoteaddrport + ') id=' + agentId);
            parent.parent.debug(1, 'Agent disconnect ' + obj.nodeid + ' (' + obj.remoteaddrport + ') id=' + agentId);

            // Log the agent disconnection
            if (parent.wsagentsDisconnections[obj.nodeid] == null) {
                parent.wsagentsDisconnections[obj.nodeid] = 1;
            } else {
                parent.wsagentsDisconnections[obj.nodeid] = ++parent.wsagentsDisconnections[obj.nodeid];
            }
        }
        obj.close(0);
    });
    // ws._socket._parent.on('close', function (req) { if (obj.nodeid != null) { parent.parent.debug(1, 'Agent TCP disconnect ' + obj.nodeid + ' (' + obj.remoteaddrport + ')'); } });

    // Start authenticate the mesh agent by sending a auth nonce & server TLS cert hash.
    // Send 384 bits SHA384 hash of TLS cert public key + 384 bits nonce
    if (args.ignoreagenthashcheck !== true) {
        obj.send(common.ShortToStr(1) + getWebCertHash(domain) + obj.nonce); // Command 1, hash + nonce
    }

    // Return the mesh for this device, in some cases, we may auto-create the mesh.
    function getMeshAutoCreate() {
        const mesh = parent.meshes[obj.dbMeshKey];
        if ((mesh == null) && (typeof domain.orphanagentuser == 'string')) {
            const adminUser = parent.users['user/' + domain.id + '/' + domain.orphanagentuser.toLowerCase()];
            if ((adminUser != null) && (adminUser.siteadmin == 0xFFFFFFFF)) {
                // Mesh name is hex instead of base64
                const meshname = obj.meshid.substring(0, 18);

                // Create a new mesh for this device
                const links = {};
                links[adminUser._id] = { name: adminUser.name, rights: 0xFFFFFFFF };
                mesh = { type: 'mesh', _id: obj.dbMeshKey, name: meshname, mtype: 2, desc: '', domain: domain.id, links: links };
                db.Set(common.escapeLinksFieldName(mesh));
                parent.meshes[obj.dbMeshKey] = mesh;

                if (adminUser.links == null) adminUser.links = {};
                adminUser.links[obj.dbMeshKey] = { rights: 0xFFFFFFFF };
                db.SetUser(adminUser);
                parent.parent.DispatchEvent(['*', obj.dbMeshKey, adminUser._id], obj, { etype: 'mesh', username: adminUser.name, meshid: obj.dbMeshKey, name: meshname, mtype: 2, desc: '', action: 'createmesh', links: links, msg: 'Mesh created: ' + obj.meshid, domain: domain.id });
            }
        } else {
            if ((mesh != null) && (mesh.deleted != null) && (mesh.links)) {
                // Must un-delete this mesh
                var ids = ['*', mesh._id];

                // See if users still exists, if so, add links to the mesh
                for (var userid in mesh.links) {
                    const user = parent.users[userid];
                    if (user) {
                        if (user.links == null) { user.links = {}; }
                        if (user.links[mesh._id] == null) {
                            user.links[mesh._id] = { rights: mesh.links[userid].rights };
                            ids.push(user._id);
                            db.SetUser(user);
                        }
                    }
                }

                // Send out an event indicating this mesh was "created"
                parent.parent.DispatchEvent(ids, obj, { etype: 'mesh', meshid: mesh._id, name: mesh.name, mtype: mesh.mtype, desc: mesh.desc, action: 'createmesh', links: mesh.links, msg: 'Mesh undeleted: ' + mesh._id, domain: domain.id });

                // Mark the mesh as active
                delete mesh.deleted;
                db.Set(common.escapeLinksFieldName(mesh));
            }
        }
        return mesh;
    }

    // Once we get all the information about an agent, run this to hook everything up to the server
    function completeAgentConnection() {
        if ((obj.authenticated != 1) || (obj.meshid == null) || obj.pendingCompleteAgentConnection || (obj.agentInfo == null)) { return; }
        obj.pendingCompleteAgentConnection = true;

        // Check if we have too many agent sessions
        if (typeof domain.limits.maxagentsessions == 'number') {
            // Count the number of agent sessions for this domain
            var domainAgentSessionCount = 0;
            for (var i in parent.wsagents) { if (parent.wsagents[i].domain.id == domain.id) { domainAgentSessionCount++; } }

            // Check if we have too many user sessions
            if (domainAgentSessionCount >= domain.limits.maxagentsessions) { return; } // Too many, hold the connection.
        }

        /*
        // Check that the mesh exists
        var mesh = parent.meshes[obj.dbMeshKey];
        if (mesh == null) {
            var holdConnection = true;
            if (typeof domain.orphanagentuser == 'string') {
                var adminUser = parent.users['user/' + domain.id + '/' + args.orphanagentuser];
                if ((adminUser != null) && (adminUser.siteadmin == 0xFFFFFFFF)) {
                    // Create a new mesh for this device
                    holdConnection = false;
                    var links = {};
                    links[user._id] = { name: adminUser.name, rights: 0xFFFFFFFF };
                    mesh = { type: 'mesh', _id: obj.dbMeshKey, name: obj.meshid, mtype: 2, desc: '', domain: domain.id, links: links };
                    db.Set(common.escapeLinksFieldName(mesh));
                    parent.meshes[obj.meshid] = mesh;
                    parent.parent.AddEventDispatch([obj.meshid], ws);

                    if (adminUser.links == null) user.links = {};
                    adminUser.links[obj.meshid] = { rights: 0xFFFFFFFF };
                    //adminUser.subscriptions = parent.subscribe(adminUser._id, ws);
                    db.SetUser(user);
                    parent.parent.DispatchEvent(['*', meshid, user._id], obj, { etype: 'mesh', username: user.name, meshid: obj.meshid, name: obj.meshid, mtype: 2, desc: '', action: 'createmesh', links: links, msg: 'Mesh created: ' + obj.meshid, domain: domain.id });
                }
            }

            if (holdConnection == true) {
                // If we disconnect, the agent will just reconnect. We need to log this or tell agent to connect in a few hours.
                console.log('Agent connected with invalid domain/mesh, holding connection (' + obj.remoteaddrport + ', ' + obj.dbMeshKey + ').');
                return;
            }
        } 
        if (mesh.mtype != 2) { console.log('Agent connected with invalid mesh type, holding connection (' + obj.remoteaddrport + ').'); return; } // If we disconnect, the agnet will just reconnect. We need to log this or tell agent to connect in a few hours.
        */

        // Check that the node exists
        db.Get(obj.dbNodeKey, function (err, nodes) {
            if (obj.agentInfo == null) { return; }
            var device;

            // See if this node exists in the database
            if (nodes.length == 0) {
                // This device does not exist, use the meshid given by the device

                // See if this mesh exists, if it does not we may want to create it.
                const mesh = getMeshAutoCreate();

                // Check if the mesh exists
                if (mesh == null) {
                    // If we disconnect, the agent will just reconnect. We need to log this or tell agent to connect in a few hours.
                    console.log('Agent connected with invalid domain/mesh, holding connection (' + obj.remoteaddrport + ', ' + obj.dbMeshKey + ').');
                    return;
                }

                // Check if the mesh is the right type
                if (mesh.mtype != 2) {
                    // If we disconnect, the agent will just reconnect. We need to log this or tell agent to connect in a few hours.
                    console.log('Agent connected with invalid mesh type, holding connection (' + obj.remoteaddrport + ').');
                    return;
                }

                // Mark when this device connected
                obj.connectTime = Date.now();
                db.Set({ _id: 'lc' + obj.dbNodeKey, type: 'lastconnect', domain: domain.id, time: obj.connectTime, addr: obj.remoteaddrport });

                // This node does not exist, create it.
                device = { type: 'node', mtype: mesh.mtype, _id: obj.dbNodeKey, icon: obj.agentInfo.platformType, meshid: obj.dbMeshKey, name: obj.agentInfo.computerName, rname: obj.agentInfo.computerName, domain: domain.id, agent: { ver: obj.agentInfo.agentVersion, id: obj.agentInfo.agentId, caps: obj.agentInfo.capabilities }, host: null };
                db.Set(device);

                // Event the new node
                if (obj.agentInfo.capabilities & 0x20) {
                    // This is a temporary agent, don't log.
                    parent.parent.DispatchEvent(['*', obj.dbMeshKey], obj, { etype: 'node', action: 'addnode', node: device, domain: domain.id, nolog: 1 });
                } else {
                    parent.parent.DispatchEvent(['*', obj.dbMeshKey], obj, { etype: 'node', action: 'addnode', node: device, msg: ('Added device ' + obj.agentInfo.computerName + ' to mesh ' + mesh.name), domain: domain.id });
                }
            } else {
                device = nodes[0];

                // This device exists, meshid given by the device must be ignored, use the server side one.
                if (device.meshid != obj.dbMeshKey) {
                    obj.dbMeshKey = device.meshid;
                    obj.meshid = device.meshid.split('/')[2];
                }

                // See if this mesh exists, if it does not we may want to create it.
                const mesh = getMeshAutoCreate();

                // Check if the mesh exists
                if (mesh == null) {
                    // If we disconnect, the agent will just reconnect. We need to log this or tell agent to connect in a few hours.
                    console.log('Agent connected with invalid domain/mesh, holding connection (' + obj.remoteaddrport + ', ' + obj.dbMeshKey + ').');
                    return;
                }

                // Check if the mesh is the right type
                if (mesh.mtype != 2) {
                    // If we disconnect, the agent will just reconnect. We need to log this or tell agent to connect in a few hours.
                    console.log('Agent connected with invalid mesh type, holding connection (' + obj.remoteaddrport + ').');
                    return;
                } 

                // Mark when this device connected
                obj.connectTime = Date.now();
                db.Set({ _id: 'lc' + obj.dbNodeKey, type: 'lastconnect', domain: domain.id, time: obj.connectTime, addr: obj.remoteaddrport });

                // Device already exists, look if changes has occured
                var changes = [], change = 0, log = 0;
                if (device.agent == null) { device.agent = { ver: obj.agentInfo.agentVersion, id: obj.agentInfo.agentId, caps: obj.agentInfo.capabilities }; change = 1; }
                if (device.rname != obj.agentInfo.computerName) { device.rname = obj.agentInfo.computerName; change = 1; changes.push('computer name'); }
                if (device.agent.ver != obj.agentInfo.agentVersion) { device.agent.ver = obj.agentInfo.agentVersion; change = 1; changes.push('agent version'); }
                if (device.agent.id != obj.agentInfo.agentId) { device.agent.id = obj.agentInfo.agentId; change = 1; changes.push('agent type'); }
                if ((device.agent.caps & 24) != (obj.agentInfo.capabilities & 24)) { device.agent.caps = obj.agentInfo.capabilities; change = 1; changes.push('agent capabilities'); } // If agent console or javascript support changes, update capabilities
                if (change == 1) {
                    db.Set(device);

                    // If this is a temporary device, don't log changes
                    if (obj.agentInfo.capabilities & 0x20) { log = 0; }

                    // Event the node change
                    var event = { etype: 'node', action: 'changenode', nodeid: obj.dbNodeKey, domain: domain.id };
                    if (log == 0) { event.nolog = 1; } else { event.msg = 'Changed device ' + device.name + ' from group ' + mesh.name + ': ' + changes.join(', '); }
                    const device2 = common.Clone(device);
                    if (device2.intelamt && device2.intelamt.pass) delete device2.intelamt.pass; // Remove the Intel AMT password before eventing this.
                    event.node = device;
                    parent.parent.DispatchEvent(['*', device.meshid], obj, event);
                }
            }

            // Check if this agent is already connected
            const dupAgent = parent.wsagents[obj.dbNodeKey];
            parent.wsagents[obj.dbNodeKey] = obj;
            if (dupAgent) {
                // Close the duplicate agent
                if (obj.nodeid != null) { parent.parent.debug(1, 'Duplicate agent ' + obj.nodeid + ' (' + obj.remoteaddrport + ')'); }
                dupAgent.close(3);
            } else {
                // Indicate the agent is connected
                parent.parent.SetConnectivityState(obj.dbMeshKey, obj.dbNodeKey, obj.connectTime, 1, 1);
            }

            // We are done, ready to communicate with this agent
            delete obj.pendingCompleteAgentConnection;
            obj.authenticated = 2;

            // Check how many times this agent disconnected in the last few minutes.
            const disconnectCount = parent.wsagentsDisconnections[obj.nodeid];
            if (disconnectCount > 6) {
                console.log('Agent in big trouble: NodeId=' + obj.nodeid + ', IP=' + obj.remoteaddrport + ', Agent=' + obj.agentInfo.agentId + '.');
                // TODO: Log or do something to recover?
                return;
            }

            // Command 4, inform mesh agent that it's authenticated.
            obj.send(common.ShortToStr(4));

            if (disconnectCount > 4) {
                // Too many disconnections, this agent has issues. Just clear the core.
                obj.send(common.ShortToStr(10) + common.ShortToStr(0));
                //console.log('Agent in trouble: NodeId=' + obj.nodeid + ', IP=' + obj.remoteaddrport + ', Agent=' + obj.agentInfo.agentId + '.');
                // TODO: Log or do something to recover?
                return;
            }

            // Not sure why, but in rare cases, obj.agentInfo is undefined here.
            if ((obj.agentInfo == null) || (typeof obj.agentInfo.capabilities != 'number')) { return; } // This is an odd case.

            if ((obj.agentInfo.capabilities & 64) != 0) {
                // This is a recovery agent
                obj.send(common.ShortToStr(11) + common.ShortToStr(0)); // Command 11, ask for mesh core hash.
            } else {
                // Check if we need to make an native update check
                obj.agentExeInfo = parent.parent.meshAgentBinaries[obj.agentInfo.agentId];
                const corename = parent.parent.meshAgentsArchitectureNumbers[obj.agentInfo.agentId].core;
                if (corename == null) { obj.send(common.ShortToStr(10) + common.ShortToStr(0)); } // MeshCommand_CoreModule, ask mesh agent to clear the core

                if ((obj.agentExeInfo != null) && (obj.agentExeInfo.update == true)) {
                    // Ask the agent for it's executable binary hash
                    obj.send(common.ShortToStr(12) + common.ShortToStr(0));
                } else {
                    // Check the mesh core, if the agent is capable of running one
                    if (((obj.agentInfo.capabilities & 16) != 0) && (corename != null)) {
                        obj.send(common.ShortToStr(11) + common.ShortToStr(0)); // Command 11, ask for mesh core hash.
                    } else {
                        agentCoreIsStable(); // No updates needed, agent is ready to go.
                    }
                }
            }
        });
    }

    function recoveryAgentCoreIsStable() {
        // Recovery agent is doing ok, lets perform main agent checking.

        // TODO
        console.log('recoveryAgentCoreIsStable()');

        // Close the recovery agent connection when done.
        //obj.close(1);
    }

    // Take a basic Intel AMT policy and add all server information to it, making it ready to send to this agent.
    function completeIntelAmtPolicy(amtPolicy) {
        if (amtPolicy == null) return null;
        if (amtPolicy.type == 2) {
            // Add server root certificate
            if (parent.parent.certificates.rootex == null) { parent.parent.certificates.rootex = parent.parent.certificates.root.cert.split('-----BEGIN CERTIFICATE-----').join('').split('-----END CERTIFICATE-----').join('').split('\r').join('').split('\n').join(''); }
            amtPolicy.rootcert = parent.parent.certificates.rootex;
        }
        if ((amtPolicy.cirasetup == 2) && (parent.parent.mpsserver != null) && (parent.parent.certificates.AmtMpsName != null) && (args.lanonly != true) && (args.mpsport != 0)) {
            // Add server CIRA settings
            amtPolicy.ciraserver = {
                name: parent.parent.certificates.AmtMpsName,
                port: (typeof args.mpsaliasport == 'number' ? args.mpsaliasport : args.mpsport),
                user: obj.meshid.replace(/\@/g, 'X').replace(/\$/g, 'X').substring(0, 16),
                pass: args.mpspass ? args.mpspass : 'A@xew9rt', // If the MPS password is not set, just use anything. TODO: Use the password as an agent identifier?
                home: ['sdlwerulis3wpj95dfj'] // Use a random FQDN to not have any home network.
            };
            if (Array.isArray(args.ciralocalfqdn)) { amtPolicy.ciraserver.home = args.ciralocalfqdn; }
        }
        return amtPolicy;
    }

    // Send Intel AMT policy
    obj.sendUpdatedIntelAmtPolicy = function (policy) {
        if (obj.agentExeInfo && (obj.agentExeInfo.amt == true)) { // Only send Intel AMT policy to agents what could have AMT.
            if (policy == null) { var mesh = parent.meshes[obj.dbMeshKey]; if (mesh == null) return; policy = mesh.amt; }
            if (policy != null) { try { obj.send(JSON.stringify({ action: 'amtPolicy', amtPolicy: completeIntelAmtPolicy(common.Clone(policy)) })); } catch (ex) { } }
        }
    }

    function agentCoreIsStable() {
        // Check that the mesh exists
        const mesh = parent.meshes[obj.dbMeshKey];
        if (mesh == null) {
            // TODO: Mark this agent as part of a mesh that does not exists.
            return; // Probably not worth doing anything else. Hold this agent.
        }

        // Send Intel AMT policy
        if (obj.agentExeInfo && (obj.agentExeInfo.amt == true) && (mesh.amt != null)) {  // Only send Intel AMT policy to agents what could have AMT.
            try { obj.send(JSON.stringify({ action: 'amtPolicy', amtPolicy: completeIntelAmtPolicy(common.Clone(mesh.amt)) })); } catch (ex) { }
        }

        // Do this if IP location is enabled on this domain TODO: Set IP location per device group?
        if (domain.iplocation == true) {
            // Check if we already have IP location information for this node
            db.Get('iploc_' + obj.remoteaddr, function (err, iplocs) {
                if (iplocs.length == 1) {
                    // We have a location in the database for this remote IP
                    const iploc = nodes[0], x = {};
                    if ((iploc != null) && (iploc.ip != null) && (iploc.loc != null)) {
                        x.publicip = iploc.ip;
                        x.iploc = iploc.loc + ',' + (Math.floor((new Date(iploc.date)) / 1000));
                        ChangeAgentLocationInfo(x);
                    }
                } else {
                    // Check if we need to ask for the IP location
                    var doIpLocation = 0;
                    if (device.iploc == null) {
                        doIpLocation = 1;
                    } else {
                        const loc = device.iploc.split(',');
                        if (loc.length < 3) {
                            doIpLocation = 2;
                        } else {
                            var t = new Date((parseFloat(loc[2]) * 1000)), now = Date.now();
                            t.setDate(t.getDate() + 20);
                            if (t < now) { doIpLocation = 3; }
                        }
                    }

                    // If we need to ask for IP location, see if we have the quota to do it.
                    if (doIpLocation > 0) {
                        db.getValueOfTheDay('ipLocationRequestLimitor', 10, function (ipLocationLimitor) {
                            if (ipLocationLimitor.value > 0) {
                                ipLocationLimitor.value--;
                                db.Set(ipLocationLimitor);
                                obj.send(JSON.stringify({ action: 'iplocation' }));
                            }
                        });
                    }
                }
            });
        }
    }

    // Get the web certificate private key hash for the specified domain
    function getWebCertHash(domain) {
        const hash = parent.webCertificateHashs[domain.id];
        if (hash != null) return hash;
        return parent.webCertificateHash;
    }

    // Get the web certificate hash for the specified domain
    function getWebCertFullHash(domain) {
        const hash = parent.webCertificateFullHashs[domain.id];
        if (hash != null) return hash;
        return parent.webCertificateFullHash;
    }

    // Verify the agent signature
    function processAgentSignature(msg) {
        if (args.ignoreagenthashcheck !== true) {
            var verified = false;

            if (msg.length != 384) {
                // Verify a PKCS7 signature.
                var msgDer = null;
                try { msgDer = forge.asn1.fromDer(forge.util.createBuffer(msg, 'binary')); } catch (ex) { }
                if (msgDer != null) {
                    try {
                        var p7 = forge.pkcs7.messageFromAsn1(msgDer);
                        var sig = p7.rawCapture.signature;

                        // Verify with key hash
                        var buf = Buffer.from(getWebCertHash(domain) + obj.nonce + obj.agentnonce, 'binary');
                        var verifier = parent.crypto.createVerify('RSA-SHA384');
                        verifier.update(buf);
                        verified = verifier.verify(obj.unauth.nodeCertPem, sig, 'binary');
                        if (verified == false) {
                            // Verify with full hash
                            buf = Buffer.from(getWebCertFullHash(domain) + obj.nonce + obj.agentnonce, 'binary');
                            verifier = parent.crypto.createVerify('RSA-SHA384');
                            verifier.update(buf);
                            verified = verifier.verify(obj.unauth.nodeCertPem, sig, 'binary');
                        }
                        if (verified == false) { return false; } // Not a valid signature
                    } catch (ex) { };
                }
            }

            if (verified == false) {
                // Verify the RSA signature. This is the fast way, without using forge.
                const verify = parent.crypto.createVerify('SHA384');
                verify.end(Buffer.from(getWebCertHash(domain) + obj.nonce + obj.agentnonce, 'binary')); // Test using the private key hash
                if (verify.verify(obj.unauth.nodeCertPem, Buffer.from(msg, 'binary')) !== true) {
                    const verify2 = parent.crypto.createVerify('SHA384');
                    verify2.end(Buffer.from(getWebCertFullHash(domain) + obj.nonce + obj.agentnonce, 'binary'));  // Test using the full cert hash
                    if (verify2.verify(obj.unauth.nodeCertPem, Buffer.from(msg, 'binary')) !== true) { return false; }
                }
            }
        }

        // Connection is a success, clean up
        obj.nodeid = obj.unauth.nodeid;
        obj.dbNodeKey = 'node/' + domain.id + '/' + obj.nodeid;
        delete obj.nonce;
        delete obj.agentnonce;
        delete obj.unauth;
        delete obj.receivedCommands;
        if (obj.unauthsign) delete obj.unauthsign;
        parent.parent.debug(1, 'Verified agent connection to ' + obj.nodeid + ' (' + obj.remoteaddrport + ').');
        obj.authenticated = 1;
        return true;
    }

    // Process incoming agent JSON data
    function processAgentData(msg) {
        var i, str = msg.toString('utf8'), command = null;
        if (str[0] == '{') {
            try { command = JSON.parse(str); } catch (ex) { console.log('Unable to parse agent JSON (' + obj.remoteaddrport + '): ' + str, ex); return; } // If the command can't be parsed, ignore it.
            if (typeof command != 'object') { return; }
            switch (command.action) {
                case 'msg':
                    {
                        // Route a message.
                        // If this command has a sessionid, that is the target.
                        if (command.sessionid != null) {
                            if (typeof command.sessionid != 'string') break;
                            var splitsessionid = command.sessionid.split('/');
                            // Check that we are in the same domain and the user has rights over this node.
                            if ((splitsessionid[0] == 'user') && (splitsessionid[1] == domain.id)) {
                                // Check if this user has rights to get this message
                                //if (mesh.links[user._id] == null || ((mesh.links[user._id].rights & 16) == 0)) return; // TODO!!!!!!!!!!!!!!!!!!!!!

                                // See if the session is connected. If so, go ahead and send this message to the target node
                                var ws = parent.wssessions2[command.sessionid];
                                if (ws != null) {
                                    command.nodeid = obj.dbNodeKey; // Set the nodeid, required for responses.
                                    delete command.sessionid;       // Remove the sessionid, since we are sending to that sessionid, so it's implyed.
                                    try { ws.send(JSON.stringify(command)); } catch (ex) { }
                                } else if (parent.parent.multiServer != null) {
                                    // See if we can send this to a peer server
                                    var serverid = parent.wsPeerSessions2[command.sessionid];
                                    if (serverid != null) {
                                        command.fromNodeid = obj.dbNodeKey;
                                        parent.parent.multiServer.DispatchMessageSingleServer(command, serverid);
                                    }
                                }
                            }
                        } else if (command.userid != null) { // If this command has a userid, that is the target.
                            if (typeof command.userid != 'string') break;
                            var splituserid = command.userid.split('/');
                            // Check that we are in the same domain and the user has rights over this node.
                            if ((splituserid[0] == 'user') && (splituserid[1] == domain.id)) {
                                // Check if this user has rights to get this message
                                //if (mesh.links[user._id] == null || ((mesh.links[user._id].rights & 16) == 0)) return; // TODO!!!!!!!!!!!!!!!!!!!!!

                                // See if the session is connected
                                var sessions = parent.wssessions[command.userid];

                                // Go ahead and send this message to the target node
                                if (sessions != null) {
                                    command.nodeid = obj.dbNodeKey; // Set the nodeid, required for responses.
                                    delete command.userid;          // Remove the userid, since we are sending to that userid, so it's implyed.
                                    for (i in sessions) { sessions[i].send(JSON.stringify(command)); }
                                }

                                if (parent.parent.multiServer != null) {
                                    // TODO: Add multi-server support
                                }
                            }
                        } else { // Route this command to the mesh
                            command.nodeid = obj.dbNodeKey;
                            var cmdstr = JSON.stringify(command);
                            for (var userid in parent.wssessions) { // Find all connected users for this mesh and send the message
                                var user = parent.users[userid];
                                if ((user != null) && (user.links != null)) {
                                    var rights = user.links[obj.dbMeshKey];
                                    if (rights != null) { // TODO: Look at what rights are needed for message routing
                                        var xsessions = parent.wssessions[userid];
                                        // Send the message to all users on this server
                                        for (i in xsessions) { try { xsessions[i].send(cmdstr); } catch (e) { } }
                                    }
                                }
                            }

                            // Send the message to all users of other servers
                            if (parent.parent.multiServer != null) {
                                delete command.nodeid;
                                command.fromNodeid = obj.dbNodeKey;
                                command.meshid = obj.dbMeshKey;
                                parent.parent.multiServer.DispatchMessage(command);
                            }
                        }
                        break;
                    }
                case 'coreinfo':
                    {
                        // Sent by the agent to update agent information
                        ChangeAgentCoreInfo(command);
                        break;
                    }
                case 'smbios':
                    {
                        // Store the RAW SMBios table of this computer
                        // We store SMBIOS information as a string because we don't want the MongoDB to attempt to store all of the sub-documents seperatly.
                        // If an agent sends an insanely large SMBIOS table, don't store it.
                        try {
                            var smbiosstr = JSON.stringify(command.value);
                            if (smbiosstr.length < 65535) { db.SetSMBIOS({ _id: obj.dbNodeKey, domain: domain.id, time: new Date(), value: smbiosstr }); }
                        } catch (ex) { }

                        // Event the node interface information change (This is a lot of traffic, probably don't need this).
                        //parent.parent.DispatchEvent(['*', obj.meshid], obj, { action: 'smBiosChange', nodeid: obj.dbNodeKey, domain: domain.id, smbios: command.value,  nolog: 1 });

                        break;
                    }
                case 'netinfo':
                    {
                        // Sent by the agent to update agent network interface information
                        delete command.action;
                        command.updateTime = Date.now();
                        command._id = 'if' + obj.dbNodeKey;
                        command.type = 'ifinfo';
                        db.Set(command);

                        // Event the node interface information change
                        parent.parent.DispatchEvent(['*', obj.meshid], obj, { action: 'ifchange', nodeid: obj.dbNodeKey, domain: domain.id, nolog: 1 });

                        break;
                    }
                case 'iplocation':
                    {
                        // Sent by the agent to update location information
                        if ((command.type == 'publicip') && (command.value != null) && (typeof command.value == 'object') && (command.value.ip) && (command.value.loc)) {
                            var x = {};
                            x.publicip = command.value.ip;
                            x.iploc = command.value.loc + ',' + (Math.floor(Date.now() / 1000));
                            ChangeAgentLocationInfo(x);
                            command.value._id = 'iploc_' + command.value.ip;
                            command.value.type = 'iploc';
                            command.value.date = Date.now();
                            db.Set(command.value); // Store the IP to location data in the database
                            // Sample Value: { ip: '192.55.64.246', city: 'Hillsboro', region: 'Oregon', country: 'US', loc: '45.4443,-122.9663', org: 'AS4983 Intel Corporation', postal: '97123' }
                        }
                        break;
                    }
                case 'mc1migration':
                    {
                        if (command.oldnodeid.length != 64) break;
                        const oldNodeKey = 'node//' + command.oldnodeid.toLowerCase();
                        db.Get(oldNodeKey, function (err, nodes) {
                            if (nodes.length != 1) return;
                            const node = nodes[0];
                            if (node.meshid == obj.dbMeshKey) {
                                // Update the device name & host
                                const newNode = { "name": node.name };
                                if (node.intelamt != null) { newNode.intelamt = node.intelamt; }
                                ChangeAgentCoreInfo(newNode);

                                // Delete this node including network interface information and events
                                db.Remove(node._id);
                                db.Remove('if' + node._id);

                                // Event node deletion
                                const change = 'Migrated device ' + node.name;
                                parent.parent.DispatchEvent(['*', node.meshid], obj, { etype: 'node', action: 'removenode', nodeid: node._id, msg: change, domain: node.domain });
                            }
                        });
                        break;
                    }
                case 'openUrl':
                    {
                        // Sent by the agent to return the status of a open URL action.
                        // Nothing is done right now.
                        break;
                    }
                case 'getScript':
                    {
                        // Used by the agent to get configuration scripts.
                        if (command.type == 1) {
                            parent.getCiraConfigurationScript(obj.dbMeshKey, function (script) {
                                obj.send(JSON.stringify({ action: 'getScript', type: 1, script: script.toString() }));
                            });
                        } else if (command.type == 2) {
                            parent.getCiraCleanupScript(function (script) {
                                obj.send(JSON.stringify({ action: 'getScript', type: 2, script: script.toString() }));
                            });
                        }
                        break;
                    }
                default: {
                    console.log('Unknown agent action (' + obj.remoteaddrport + '): ' + command.action + '.');
                    break;
                }
            }
        }
    }

    // Change the current core information string and event it
    function ChangeAgentCoreInfo(command) {
        if ((command == null) || (command == null)) return; // Safety, should never happen.

        // Check that the mesh exists
        const mesh = parent.meshes[obj.dbMeshKey];
        if (mesh == null) return;

        // Get the node and change it if needed
        db.Get(obj.dbNodeKey, function (err, nodes) { // TODO: THIS IS A BIG RACE CONDITION HERE, WE NEED TO FIX THAT. If this call is made twice at the same time on the same device, data will be missed.
            if (nodes.length != 1) return;
            const device = nodes[0];
            if (device.agent) {
                var changes = [], change = 0, log = 0;

                //if (command.users) { console.log(command.users); }

                // Check if anything changes
                if (command.name && (command.name != device.name)) { change = 1; log = 1; device.name = command.name; changes.push('name'); }
                if ((command.caps != null) && (device.agent.core != command.value)) { if ((command.value == null) && (device.agent.core != null)) { delete device.agent.core; } else { device.agent.core = command.value; } change = 1; } // Don't save this as an event to the db.
                if ((command.caps != null) && ((device.agent.caps & 0xFFFFFFE7) != (command.caps & 0xFFFFFFE7))) { device.agent.caps = ((device.agent.caps & 24) + (command.caps & 0xFFFFFFE7)); change = 1; } // Allow Javascript on the agent to change all capabilities except console and javascript support, Don't save this as an event to the db.
                if ((command.osdesc != null) && (device.osdesc != command.osdesc)) { device.osdesc = command.osdesc; change = 1; changes.push('os desc'); } // Don't save this as an event to the db.
                if (device.ip != obj.remoteaddr) { device.ip = obj.remoteaddr; change = 1; }
                if (command.intelamt) {
                    if (!device.intelamt) { device.intelamt = {}; }
                    if ((command.intelamt.ver != null) && (device.intelamt.ver != command.intelamt.ver)) { changes.push('AMT version'); device.intelamt.ver = command.intelamt.ver; change = 1; log = 1; }
                    if ((command.intelamt.state != null) && (device.intelamt.state != command.intelamt.state)) { changes.push('AMT state'); device.intelamt.state = command.intelamt.state; change = 1; log = 1; }
                    if ((command.intelamt.flags != null) && (device.intelamt.flags != command.intelamt.flags)) {
                        if (device.intelamt.flags) { changes.push('AMT flags (' + device.intelamt.flags + ' --> ' + command.intelamt.flags + ')'); } else { changes.push('AMT flags (' + command.intelamt.flags + ')'); }
                        device.intelamt.flags = command.intelamt.flags; change = 1; log = 1;
                    }
                    if ((command.intelamt.host != null) && (device.intelamt.host != command.intelamt.host)) { changes.push('AMT host'); device.intelamt.host = command.intelamt.host; change = 1; log = 1; }
                    if ((command.intelamt.uuid != null) && (device.intelamt.uuid != command.intelamt.uuid)) { changes.push('AMT uuid'); device.intelamt.uuid = command.intelamt.uuid; change = 1; log = 1; }
                    if ((command.intelamt.user != null) && (device.intelamt.user != command.intelamt.user)) { changes.push('AMT user'); device.intelamt.user = command.intelamt.user; change = 1; log = 1; }
                    if ((command.intelamt.pass != null) && (device.intelamt.pass != command.intelamt.pass)) { changes.push('AMT pass'); device.intelamt.pass = command.intelamt.pass; change = 1; log = 1; }
                }
                if ((command.users != null) && (device.users != command.users)) { device.users = command.users; change = 1; } // Don't save this to the db.
                if ((mesh.mtype == 2) && (!args.wanonly)) {
                    // In WAN mode, the hostname of a computer is not important. Don't log hostname changes.
                    if (device.host != obj.remoteaddr) { device.host = obj.remoteaddr; change = 1; changes.push('host'); }
                    // TODO: Check that the agent has an interface that is the same as the one we got this websocket connection on. Only set if we have a match.
                }

                // If there are changes, event the new device
                if (change == 1) {
                    // Save to the database
                    db.Set(device);

                    // Event the node change
                    var event = { etype: 'node', action: 'changenode', nodeid: obj.dbNodeKey, domain: domain.id };
                    if (changes.length > 0) { event.msg = 'Changed device ' + device.name + ' from group ' + mesh.name + ': ' + changes.join(', '); }
                    if ((log == 0) || (obj.agentInfo.capabilities & 0x20) || (changes.length == 0)) { event.nolog = 1; } // If this is a temporary device, don't log changes
                    var device2 = common.Clone(device);
                    if (device2.intelamt && device2.intelamt.pass) { delete device2.intelamt.pass; } // Remove the Intel AMT password before eventing this.
                    event.node = device;
                    parent.parent.DispatchEvent(['*', device.meshid], obj, event);
                }
            }
        });
    }

    // Change the current core information string and event it
    function ChangeAgentLocationInfo(command) {
        if ((command == null) || (command == null)) { return; } // Safety, should never happen.

        // Check that the mesh exists
        const mesh = parent.meshes[obj.dbMeshKey];
        if (mesh == null) return;

        // Get the node and change it if needed
        db.Get(obj.dbNodeKey, function (err, nodes) {
            if (nodes.length != 1) { return; }
            const device = nodes[0];
            if (device.agent) {
                var changes = [], change = 0;

                // Check if anything changes
                if ((command.publicip) && (device.publicip != command.publicip)) { device.publicip = command.publicip; change = 1; changes.push('public ip'); }
                if ((command.iploc) && (device.iploc != command.iploc)) { device.iploc = command.iploc; change = 1; changes.push('ip location'); }

                // If there are changes, save and event
                if (change == 1) {
                    db.Set(device);

                    // Event the node change
                    var event = { etype: 'node', action: 'changenode', nodeid: obj.dbNodeKey, domain: domain.id, msg: 'Changed device ' + device.name + ' from group ' + mesh.name + ': ' + changes.join(', ') };
                    if (obj.agentInfo.capabilities & 0x20) { event.nolog = 1; } // If this is a temporary device, don't log changes
                    var device2 = common.Clone(device);
                    if (device2.intelamt && device2.intelamt.pass) { delete device2.intelamt.pass; } // Remove the Intel AMT password before eventing this.
                    event.node = device;
                    parent.parent.DispatchEvent(['*', device.meshid], obj, event);
                }
            }
        });
    }

    // Update the mesh agent tab in the database
    function ChangeAgentTag(tag) {
        if (tag.length == 0) { tag = null; }
        // Get the node and change it if needed
        db.Get(obj.dbNodeKey, function (err, nodes) {
            if (nodes.length != 1) return;
            const device = nodes[0];
            if (device.agent) {
                if (device.agent.tag != tag) {
                    device.agent.tag = tag;
                    db.Set(device);

                    // Event the node change
                    var event = { etype: 'node', action: 'changenode', nodeid: obj.dbNodeKey, domain: domain.id, nolog: 1 };
                    var device2 = common.Clone(device);
                    if (device2.intelamt && device2.intelamt.pass) delete device2.intelamt.pass; // Remove the Intel AMT password before eventing this.
                    event.node = device;
                    parent.parent.DispatchEvent(['*', device.meshid], obj, event);
                }
            }
        });
    }

    return obj;
};
