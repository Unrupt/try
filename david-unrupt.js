    var webRTCconfiguration = {
        "iceServers": [
            {urls: "stun:146.148.121.175:3478"},
            {urls: "turn:146.148.121.175:3478?transport=udp", 'credential': 'nexus5x', 'username': 'smartphone'},
        ],
        "bundlePolicy":"max-bundle","iceCandidatePoolSize":1
    };



    var pc; // actual peer connection to our friend
    var socket; // used to set up connection with our peer.
    var mid;
    var fid;
    var myac;
    var yourac;
    var yourBuffer;
    var myBuffer;
    var initiator;
    var lcandyStash = [];
    var rcandyStash = [];
    var localStream;
    var remoteStream;
    var scopes= [];
    var procs = [];
    var backlog = 0;
    var backlog_sil = 0;
    var backlog_spk = 0;
    var tick;
    var iamspeaking = false;
    var mute = false;
    var paused = false;
    var videoEnabled = false;
    var peerConnectionOfferAnswerCriteria =  {offerToReceiveAudio: true, offerToReceiveVideo: false };
    var unruptEnabled = true;
    var toggleUnrupt;
    var AudioContext = window.AudioContext || window.webkitAudioContext;


    // message stuff - used to create direct connection to peer over WEBRTC

    function messageDeal(event){
        //console.log("message is ", event.data);
        var data = JSON.parse(event.data);
        console.log("message data is ", data);
        if (data.to != mid){
            alert("message mixup");
        }
        switch (data.type) {
            case "cheatUnruptToggle":
                toggleUnrupt();
                break;
            case "offer":
                if (fid == null) {
                    fid = data.from;
                }
                pc.setRemoteDescription(data).then( _ =>
                    pc.createAnswer(peerConnectionOfferAnswerCriteria).then(ans =>
                        pc.setLocalDescription(ans).then( _ =>
                            sendMessage(fid, mid, "answer", ans.sdp)
                        )
                    )
                )
                    .catch((e) => console.log("set Remote offer error", e));
                break;
            case "answer":
                pc.setRemoteDescription(data)
                    .then( _ => {
                    $("#action").text("hangup");
                })
                    .catch(e => console.log("set Remote answer error", e) );
                break;
            case "candidate":
                var jc = {
                    sdpMLineIndex: 0,
                    candidate: data.sdp
                };
                console.log("adding candidate ", jc);
                var nc = new RTCIceCandidate(jc);
                pc.addIceCandidate(nc)
                    .then( _ => console.log("added remote candidate"))
                    .catch((e) => console.log("couldn't add candidate ", e));
                break;
        }
    }

    function sendMessage(to,from,type,data){
        var messageJ = {
            to:to,
            from:from,
            type:type,
            sdp:data
        };

        var message = JSON.stringify(messageJ);
        console.log("sending ", messageJ);
        socket.send(message);
    }

    // button actions

    function startCall(cid){
        lcandyStash = [];
        rcandyStash = [];
        fid = cid;
        pc.createOffer(peerConnectionOfferAnswerCriteria)
            .then(desc => {
                console.log("offer created",);
                pc.setLocalDescription(desc).then( d => sendMessage(fid, mid, desc.type, desc.sdp));
            })
            .catch(e => console.log("offer not created due to ", e) );
    }

    function stopCall(){
        window.location.href = window.location.href;
    }


    // webaudio processing

    // display waveform for diagnostics
    function doScopeNode(ac, node, scopename) {
        console.log("making scope node ", scopename);
        var analyser = ac.createAnalyser();
        analyser.fftSize = properties.scopeFftSize;
        node.connect(analyser);
        makeDraw(scopename, analyser);
        scopes.push(analyser);
        return analyser;
    }

    // processing incoming audio
    function yourProc(node){
        var buffer = yourBuffer;
        console.log("made unrupt buffer of size ", buffer.bufferSize, buffer);
        var silentcount = 0;
        var audiostash = [];

        var ub = $('#unruptToggle');

        var pb = $("#pause");

        console.log('PauseButton!!!', pb);

        var oldmute = false;

        toggleUnrupt = () => {
            if (unruptEnabled) {
                unruptEnabled = false;
                console.log('disconnecting the buffer');
                node.disconnect(buffer);
                document.getElementById('out').muted = false;
                document.getElementById('out').play();
                $('#pauseOther').hide();
                ub.text('Pause-while-speaking off');
            } else {
                unruptEnabled = true;
                console.log('connecting the buffer');
                node.connect(buffer);
                document.getElementById('out').muted = true;
                ub.text('Pause-while-speaking on');
            }
        }


        ub.off('click').on('click', (e) => {
            e.stopImmediatePropagation();
            toggleUnrupt();
            sendMessage(fid, mid, "cheatUnruptToggle", true);
        });

        pb.off('click').on('click', (e) => {
            e.stopImmediatePropagation();

            console.log('clicked on pause!');

            console.log('paused variable is', paused);

            if (!paused){
                paused = true;
                pb.text("unpause");
                oldmute = mute;
                setMute(true);
            } else {
                paused = false;
                pb.text("pause");
                setMute(oldmute);
            }
        });

        buffer.onaudioprocess = (ape) => {
            console.log('ARE WE STILL PROCESSING AUDIO!?!');

            if (!unruptEnabled) {
                console.log('unrupt isnt enabled so clearing the backlog numbers');
                backlog_sil = backlog_spk = 0;
                return;
            }

            var inputBuffer = ape.inputBuffer;
            // The output buffer contains the samples that will be modified and played
            var outputBuffer = ape.outputBuffer;

            // Loop through the output channels (in this case there is only one)
            if (inputBuffer.numberOfChannels == 1){
                var inputData = inputBuffer.getChannelData(0);
                var outputData = outputBuffer.getChannelData(0);

                // we (almost) always stash the inbound data
                if (audiostash.length < properties.maxStashFrames) {
                    var buff = new Float32Array(inputBuffer.length);
                    var avg = 0.0;

                    for (var sample = 0; sample < inputBuffer.length; sample++) {
                        buff[sample] = inputData[sample]; // copy
                        avg += Math.abs(buff[sample]); // sample
                    }
                    avg = avg / inputBuffer.length;
                    var silent =   (avg  < properties.farSilenceThreshold);
                    if (silent){
                        silentcount++;
                        backlog_sil++;
                    } else {
                        silentcount =0;
                        backlog_spk++;
                    }
                    audiostash.unshift({silent: silent, buff:buff, silentcount: silentcount});
                    // store annotated version
                }
                backlog = audiostash.length /10;
                if (paused || iamspeaking) {
                    for (var sample = 0; sample < inputBuffer.length; sample++) {
                        outputData[sample] = 0.0; // silence
                    }
                } else {
                    var stash = audiostash.pop();
                    if (stash.silent){
                        backlog_sil--;
                    } else {
                        backlog_spk--;
                    }

                    var deleteme = (stash.silent);

                    while ((audiostash.length > 0) && (deleteme)){
                        console.log("have backlog", audiostash.length);
                        deleteme = false;
                        if (audiostash[0].silent){
                            console.log("next one is silent too");
                            if (stash.silentcount > properties.minFramesSilenceForPlay){
                                console.log("silentcount = ", stash.silentcount);
                                deleteme = true;
                                stash = audiostash.pop();
                                if (stash.silent){
                                    backlog_sil--;
                                } else {
                                    backlog_spk--;
                                }
                            }
                        }
                    }
                    var buff = stash.buff;
                    for (var sample = 0; sample < inputBuffer.length; sample++) {
                        outputData[sample] = buff[sample];
                    }
                }
            }
        };
        node.connect(buffer);
        procs.push(buffer)
        return buffer;
    }

    // mute management
    function setMute(m){
        var mb = $("#mute");
        mute = m;
        if (m){
            mb.text("unmute");
        } else {
            mb.text("mute");
        }
        var audioTracks = localStream.getAudioTracks();
        if (audioTracks[0]) {
            audioTracks[0].enabled = !m;
        }
    }

    // processing audio from the local microphone
    function myProc(node){
        var mb = $("#mute");
        mb.click( () => {
            setMute(!mute);
        });
        var buffer = myBuffer;
        console.log("made unrupt buffer of size ", buffer.bufferSize);
        var silentcount = 0;
        buffer.onaudioprocess = ape => {
            var inputBuffer = ape.inputBuffer;

            var outputBuffer = ape.outputBuffer;

            // Loop through the output channels (in this case there is only one)
            if (inputBuffer.numberOfChannels == 1){
                var inputData = inputBuffer.getChannelData(0);
                var outputData = outputBuffer.getChannelData(0);
                // Loop through the 4096 samples
                var avg = 0.0;

                for (var sample = 0; sample < inputBuffer.length; sample++) {
                    // make output equal to the same as the input
                    outputData[sample] = inputData[sample];
                    avg += Math.abs(outputData[sample]); // sample
                }
                avg = avg / inputBuffer.length;
                var silent =   (avg  < properties.micSilenceThreshold);
                if (iamspeaking){
                    if (silent){
                        silentcount++;
                    }
                    if (silentcount > properties.minFramesSilenceForPause){
                        iamspeaking = false;
                    }
                } else {
                    if (!silent) {
                        iamspeaking = true;
                        silentcount =0;
                    }
                }
            }
        };
        node.connect(buffer);
        procs.push(buffer)
        return buffer;
    }

    // called when webRTC presents us with a fresh remote audio stream
    function addStream(stream) {

        console.log("got new stream", stream);
        remoteStream = stream;
        var mediaElement = document.getElementById('out');
        mediaElement.srcObject = stream;
        //mediaElement.muted = true;

        mediaElement.onloadedmetadata = function(e) {
            mediaElement.play();
            //mediaElement.muted = true;
        };

        var peer = yourac.createMediaStreamSource(stream);

        console.log('Sample Rate is', yourac.sampleRate);

        var scope = doScopeNode(yourac, peer, "farscope");
        var buffproc = yourProc(scope);
        var scope2 = doScopeNode(yourac, buffproc, "earscope");
        scope2.connect(yourac.destination);
    }

    // configure local peerconnection and handlers
    function setupRTC(){
        pc = new RTCPeerConnection(webRTCconfiguration, null);
        console.log("created peer connection");

        pc.onicecandidate = (e) => {
            console.log("local ice candidate", e.candidate);
            if (e.candidate != null) {
                if (pc.signalingState == 'stable') {
                    sendMessage(fid, mid, "candidate", e.candidate.candidate);
                } else {
                    console.log("stashing ice candidate");
                    lcandyStash.push(e.candidate);
                }
            }
        };
        pc.oniceconnectionstatechange = (e) => {
            console.log("ice state is changed", pc.iceConnectionState);
            if (pc.iceConnectionState === "failed"){
                stopCall();
            }
        };
        // specification of WEBRTC is in flux - so we test to see if ontrack callback exists
        if ('ontrack' in pc) {
            // if so we use it
            pc.ontrack = (event) => {
                var stream = event.streams[0];
                console.log("got remote track ", stream.kind);
                addStream(stream);
            };
        } else {
            // if not we use add stream instead
            pc.onaddstream = (event) => {
                var stream = event.stream;
                console.log("got remote stream ", stream.kind);
                addStream(stream);
            }
        }

        // use this to determine the state of the 'hangup' button and send any candidates we found quickly
        pc.onsignalingstatechange = (evt) => {
            console.log("signalling state is ", pc.signalingState);
            if (pc.signalingState == 'stable') {
                var can;
                while (can = lcandyStash.pop()) {
                    console.log("popping candidate off stash")
                    sendMessage(fid, mid, "candidate", can.candidate);
                }
                var act = $("#action");
                act.text("hangup call");
                act.click( _ => stopCall() );
            }
        };
    }

    // plumb the local audio together.
    function setupAudio() {

        myac = new AudioContext();
        yourac = new AudioContext();

        yourBuffer = yourac.createScriptProcessor(properties.procFramesize, 1, 1);
        myBuffer = myac.createScriptProcessor(properties.procFramesize, 1, 1);




        navigator.mediaDevices.getUserMedia({audio: true, video: videoEnabled})
            .then((stream) => {
                if (videoEnabled) {
                    var ourMediaElement = document.getElementById('in');
                    ourMediaElement.srcObject = stream;

                    ourMediaElement.onloadedmetadata = function(e) {
                        ourMediaElement.play();
                    };
                }

                localStream = stream; // in case we need it
                var node = myac.createMediaStreamSource(stream);
                var detect = myProc(node);
                var manl = doScopeNode(myac, detect, "nearscope");
                var dest = myac.createMediaStreamDestination();
                manl.connect(dest);
                var lstream = dest.stream;
                if (pc.addTrack) {
                    stream.getTracks().forEach(track => {
                        pc.addTrack(track, lstream);
                        console.log("added local track ", track.id, track.kind);
                    });
                } else {
                    stream.getTracks().forEach(track => {
                        if (track.kind === 'video') {
                            lstream.addTrack(track);
                        }
                    });
                    pc.addStream(lstream);
                    console.log("added local stream");
                }
            })
            .catch((e) => console.log('getUserMedia() error:', e.name));

    }

    // decide who we are initiator or recpient.
    // notice that the actual call goes in the reverse direction
    // the recipient of the invite actually creates the audiobearing peerconnection
    // the initiator then accepts this audio - This allows the initiator the chance to
    // change their mind, if their circumstances have changed since the invite was sent.

    function setRole() {
        var cid = $.getUrlVar("unruptId");
        mid = localStorage['unruptId'];
        var chooseAction = $("#chooseAction");
        var chosenAction = $("#chosenAction");
        var chooseActionAudio = $("#chooseActionAudio");
        var chooseActionVideo = $("#chooseActionVideo");
        var act = $("#action");
        if (!mid) {
            var array = new Uint32Array(8);
            window.crypto.getRandomValues(array);
            var hexCodes = [];
            for (var i = 0; i < array.length; i ++ ){
                // Using getUint32 reduces the number of iterations needed (we process 4 bytes each time)
                var value = array[i];
                // toString(16) will give the hex representation of the number without padding
                var stringValue = value.toString(16)
                // We use concatenation and slice for padding
                var padding = '00000000'
                var paddedValue = (padding + stringValue).slice(-padding.length)
                hexCodes.push(paddedValue);
            }
            mid = hexCodes.join("").toLowerCase();
            console.log("mid =", mid);
            localStorage['unruptId'] = mid;
        }
        if (cid == null){
            chooseAction.show();
            chooseActionAudio.click( _ => {
                document.location = location.pathname + "?" + "unruptId=" + mid;
            });
            chooseActionVideo.click( _ => {
                document.location =  location.pathname + "?" + "unruptId=" + mid + "&video=1";
            });
        } else {
            chosenAction.show();

            $('#audioInfo').show();

            if (videoEnabled) {
                $('#videoRow').css('display', 'flex');
            }

            socket = new WebSocket( properties.websocketURL + mid);
            socket.onmessage = messageDeal;
            socket.onopen = (_) => {

                act.text("to continue, press here");
                act.on('click', () => {
                    act.off('click');
                    console.log("connected as", mid);
                    setupRTC();
                    setupAudio();
                    initiator = (mid === cid);
                    if  (initiator) {
                        act.text("please share this page as a link");
                    } else {
                        act.text("accept call");
                        act.click( () => startCall(cid));
                    }
                })
            };
            socket.onerror = (e) => {
                console.log("can't open websocket", e);
            };
            socket.onclose = (e) => {
                console.log(" websocket closed", e);
            };

        }
    }

    // thing that draws the scopes...
    function makeDraw(canvName, anode) {
        var analyser = anode;
        var speaking = false;
        var bufferLength = analyser.frequencyBinCount;
        var dataArray = new Uint8Array(bufferLength);
        var canvas = document.getElementById(canvName);
        var badge = document.getElementById(canvName + "-badge");
        var canvasCtx = canvas.getContext("2d");
// oscilloscope - for debug.
        var draw = _ => {
// Get a canvas defined with ID "oscilloscope"
            var drawVisual = requestAnimationFrame(draw);

            analyser.getByteTimeDomainData(dataArray);

            canvasCtx.fillStyle = 'rgb(200, 200, 200)';
            //canvasCtx.fillStyle = 'rgb(0,0,0,0)';
            canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

            canvasCtx.lineWidth = 2;
            canvasCtx.strokeStyle = 'rgb(0, 0, 0)';

            canvasCtx.beginPath();

            var sliceWidth = canvas.width * 1.0 / bufferLength;
            var x = 0;
            var tot = 0.0;

            for (var i = 0; i < bufferLength; i++) {


                var v = dataArray[i] / 128.0;
                tot += Math.abs(dataArray[i]-128);
                var y = v * canvas.height / 2;

                if (i === 0) {
                    canvasCtx.moveTo(x, y);
                } else {
                    canvasCtx.lineTo(x, y);
                }

                x += sliceWidth;
            }
            var mean = tot / bufferLength;
            var newspeak =  (mean > 2.0);
            if (newspeak != speaking) {
                speaking = newspeak;
                //console.log("newspeak "+newspeak+" mean "+mean);
                badge.innerText = speaking ? "Speaking" : "Silent";
            }
            canvasCtx.lineTo(canvas.width, canvas.height / 2);
            canvasCtx.stroke();
        };
        draw();
    }



    // some housekeeping

    $.extend({
        getUrlVars: function(){
            var vars = [], hash;
            var hashes = window.location.href.slice(window.location.href.indexOf('?') + 1).split('&');
            for(var i = 0; i < hashes.length; i++)
            {
                hash = hashes[i].split('=');
                vars.push(hash[0]);
                vars[hash[0]] = hash[1];
            }
            return vars;
        },
        getUrlVar: function(name){
            return $.getUrlVars()[name];
        }
    });

    $( document ).ready( _ => {
        videoEnabled = $.getUrlVar("video") == '1';

        if(videoEnabled) {
            peerConnectionOfferAnswerCriteria = {};
            var otherUserMediaElement = document.createElement('video');
            otherUserMediaElement.id = 'out';
            otherUserMediaElement.muted = true;
            document.getElementById('otherUser').appendChild(otherUserMediaElement);

            var thisUserMediaElement = document.createElement('video');
            thisUserMediaElement.id = 'in';
            thisUserMediaElement.muted = true;
            document.getElementById('thisUser').appendChild(thisUserMediaElement);


        } else {
            var mediaElement = document.createElement('audio');
            mediaElement.id = 'out';
            mediaElement.muted = true;
            document.body.appendChild(mediaElement);
        }

        setRole();

        $('#version').text(properties.versionname);
        tick = window.setInterval( t => {
            var scale = properties.maxStashFrames / 100.0;
            var timeline_length = Math.floor(properties.maxStashFrames * properties.procFramesize / 44100);
            var spk = backlog_spk / scale;
            var sil = backlog_sil / scale;
            var timeline = Math.floor((backlog_spk + backlog_sil) * properties.procFramesize / 44100.0);
            $('#unruptbuffer_len').text(timeline + "/" + timeline_length + " seconds");
            $('#unruptbuffer_sil').css('width', sil + "%").attr('aria-valuenow', sil);
            $('#unruptbuffer_spk').css('width', spk + "%").attr('aria-valuenow', spk);

            var playout = backlog > 1 ? "playing" : "direct";
            var mode = (iamspeaking || paused) ? "paused" : playout;
            $('#mode').text(mode);
            if (remoteStream && videoEnabled && unruptEnabled) {
                var pauseIcon = $('#pauseOther');
                if (mode === "paused") {
                    otherUserMediaElement.pause();
                    pauseIcon.show();
                } else {
                    otherUserMediaElement.play();
                    pauseIcon.hide();
                }
            }
        }, 250);
    });
