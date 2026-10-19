/* Small WebRTC mesh for room video chat and a live screen share. */
(function () {
  // Room-media state and service configuration
  "use strict";

  const peers = new Map();
  const tiles = new Map();
  let identity = { userId: "", name: "" };
  let socket = null;
  let room = null;
  let localVideoStream = null;
  let localMediaStarting = false;
  let localScreenStream = null;
  let pendingScreenStart = false;
  let rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  let mediaMode = "mesh";
  let liveKitRoom = null;
  let liveKitConnecting = false;
  let liveKitSdkPromise = null;
  let liveKitScreenActive = false;
  const liveKitAudio = new Map();
  let onToast = function () {};
  let sendAction = function () { return false; };

  const ui = {
    dock: document.getElementById("mediaDock"),
    tiles: document.getElementById("videoTiles"),
    count: document.getElementById("videoChatCount"),
    status: document.getElementById("mediaCallStatus"),
    videoButton: document.getElementById("videoChatButton"),
    micButton: document.getElementById("micToggleButton"),
    cameraButton: document.getElementById("cameraToggleButton"),
    shareButton: document.getElementById("shareScreenButton"),
    stopShareButton: document.getElementById("stopScreenButton"),
    screenVideo: document.getElementById("screenShareVideo"),
    screenBadge: document.getElementById("screenShareBadge"),
    sharerName: document.getElementById("screenSharerName"),
  };

  async function refreshConfig() {
    try {
      const response = await fetch("/api/rtc-config");
      if (!response.ok) return;
      const config = await response.json();
      if (Array.isArray(config.iceServers)) rtcConfig = { iceServers: config.iceServers };
      mediaMode = config.media_mode === "sfu" && config.sfu_enabled ? "sfu" : "mesh";
    } catch (_) { /* Mesh with STUN remains available when the config endpoint is offline. */ }
  }

  function loadLiveKitSdk() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (liveKitSdkPromise) return liveKitSdkPromise;
    liveKitSdkPromise = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/livekit-client@2.22.4/dist/livekit-client.umd.min.js";
      script.async = true;
      script.onload = function () { window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error("The LiveKit browser library did not load.")); };
      script.onerror = function () { reject(new Error("The LiveKit browser library could not load.")); };
      document.head.append(script);
    });
    return liveKitSdkPromise;
  }

  function membersById() {
    const result = new Map();
    (room && room.members || []).forEach(function (member) { result.set(member.id, member); });
    return result;
  }

  // Peer-to-peer media and participant tiles
  function sendSignal(peerId, channel, signal) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "rtc.signal",
      target_id: peerId,
      channel: channel,
      signal: signal,
    }));
  }

  function addTile(id, label, stream, isLocal) {
    let tile = tiles.get(id);
    if (tile && tile.isVoice) {
      removeTile(id);
      tile = null;
    }
    if (!tile) {
      const article = document.createElement("article");
      article.className = "video-tile" + (isLocal ? " is-local" : "");
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      const caption = document.createElement("span");
      caption.className = "video-tile-name";
      article.append(video, caption);
      ui.tiles.append(article);
      tile = { article: article, video: video, caption: caption, isVoice: false, memberId: isLocal ? identity.userId : id.replace(/^peer:/, "") };
      tiles.set(id, tile);
    }
    tile.caption.textContent = label;
    if (stream && tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.play().catch(function () {});
  }

  function removeTile(id) {
    const tile = tiles.get(id);
    if (!tile) return;
    if (tile.video && tile.video.srcObject) tile.video.srcObject = null;
    tile.article.remove();
    tiles.delete(id);
  }

  function addVoiceTile(id, memberId, label, isLocal) {
    const existing = tiles.get(id);
    if (existing && !existing.isVoice) return;
    const article = existing ? existing.article : document.createElement("article");
    if (!existing) {
      article.className = "video-tile voice-tile" + (isLocal ? " is-local" : "");
      const avatar = document.createElement("span");
      avatar.className = "voice-avatar";
      avatar.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "voice-tile-copy";
      const name = document.createElement("strong");
      const mode = document.createElement("small");
      mode.textContent = "VOICE CONNECTED";
      copy.append(name, mode);
      article.append(avatar, copy);
      ui.tiles.append(article);
    }
    const name = article.querySelector(".voice-tile-copy strong");
    const avatar = article.querySelector(".voice-avatar");
    name.textContent = label;
    avatar.textContent = (label.trim().charAt(0) || "?").toUpperCase();
    tiles.set(id, { article: article, isVoice: true, memberId: memberId });
  }

  function setMediaButtonLabel(button, iconName, label) {
    if (window.WatchPartyIcons) button.replaceChildren(window.WatchPartyIcons.create(iconName, 15), document.createTextNode(" " + label));
    else button.textContent = label;
  }

  function closePeer(key) {
    const entry = peers.get(key);
    if (!entry) return;
    peers.delete(key);
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.close();
    if (entry.remoteAudio) {
      entry.remoteAudio.pause();
      entry.remoteAudio.srcObject = null;
      entry.remoteAudio.remove();
      entry.remoteAudio = null;
    }
    if (entry.channel === "video") removeTile("peer:" + entry.remoteId);
  }

  function peerFor(remoteId, channel) {
    const key = channel + ":" + remoteId;
    if (peers.has(key)) return peers.get(key);

    const pc = new RTCPeerConnection(rtcConfig);
    const entry = {
      key: key,
      pc: pc,
      channel: channel,
      remoteId: remoteId,
      polite: identity.userId.localeCompare(remoteId) > 0,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      pendingCandidates: [],
    };
    peers.set(key, entry);

    const outgoing = channel === "video" ? localVideoStream :
      (room && room.screen_sharer === identity.userId ? localScreenStream : null);
    if (outgoing) {
      outgoing.getTracks().forEach(function (track) { pc.addTrack(track, outgoing); });
    } else if (channel === "screen") {
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.onicecandidate = function (event) {
      if (event.candidate) sendSignal(remoteId, channel, { candidate: event.candidate });
    };
    pc.onnegotiationneeded = async function () {
      if (channel === "screen" && (!room || room.screen_sharer !== identity.userId)) return;
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(remoteId, channel, { description: pc.localDescription });
      } catch (error) {
        console.warn("WebRTC negotiation could not start", error);
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.ontrack = function (event) {
      const incoming = event.streams[0] || new MediaStream([event.track]);
      if (channel === "screen") {
        ui.screenVideo.srcObject = incoming;
        ui.screenVideo.classList.remove("hidden");
        ui.screenBadge.classList.remove("hidden");
        const sharer = membersById().get(remoteId);
        ui.sharerName.textContent = sharer ? "· " + sharer.name : "";
        ui.screenVideo.play().catch(function () {});
        ui.status.textContent = "Live screen from " + (sharer ? sharer.name : "a room member");
      } else if (event.track.kind === "audio") {
        if (!entry.remoteAudio) {
          const audio = document.createElement("audio");
          audio.autoplay = true;
          audio.playsInline = true;
          audio.className = "sfu-audio";
          document.body.append(audio);
          entry.remoteAudio = audio;
        }
        entry.remoteAudio.srcObject = incoming;
        entry.remoteAudio.play().catch(function () {});
      } else if (event.track.kind === "video") {
        const member = membersById().get(remoteId);
        const key = "peer:" + remoteId;
        const label = member ? member.name : "Room guest";
        event.track.onended = function () {
          removeTile(key);
          if (room && (room.video_members || []).includes(remoteId)) addVoiceTile(key, remoteId, label, false);
        };
        addTile(key, label, incoming, false);
        renderVideoChatStatus();
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed") {
        ui.status.textContent = "Media path failed · check network or TURN settings";
      } else if (pc.connectionState === "connected") {
        ui.status.textContent = "Room media connected";
      }
    };
    return entry;
  }

  async function receiveSignal(message) {
    const remoteId = message.from_id;
    const channel = message.channel;
    const signal = message.signal || {};
    if (!remoteId || !["video", "screen"].includes(channel)) return;
    const entry = peerFor(remoteId, channel);
    const pc = entry.pc;

    if (signal.description) {
      const description = signal.description;
      const readyForOffer = !entry.makingOffer &&
        (pc.signalingState === "stable" || entry.settingRemoteAnswer);
      const offerCollision = description.type === "offer" && !readyForOffer;
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      entry.settingRemoteAnswer = description.type === "answer";
      await pc.setRemoteDescription(description);
      entry.settingRemoteAnswer = false;
      if (description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal(remoteId, channel, { description: pc.localDescription });
      }
      const waiting = entry.pendingCandidates.splice(0);
      for (const candidate of waiting) await pc.addIceCandidate(candidate);
    }
    if (signal.candidate) {
      if (!pc.remoteDescription) entry.pendingCandidates.push(signal.candidate);
      else if (!entry.ignoreOffer) await pc.addIceCandidate(signal.candidate);
    }
  }

  // LiveKit tracks and room lifecycle
  function isScreenTrack(publication, sdk) {
    return publication && publication.source === sdk.Track.Source.ScreenShare;
  }

  function hasLiveKitScreenAudio() {
    if (!liveKitRoom || !window.LivekitClient) return false;
    const source = window.LivekitClient.Track.Source.ScreenShareAudio || "screen_share_audio";
    let found = false;
    liveKitRoom.localParticipant.trackPublications.forEach(function (publication) {
      if (publication.source === source) found = true;
    });
    return found;
  }

  function mountLiveKitTrack(track, publication, participant, isLocal) {
    if (!track || !publication || !window.LivekitClient) return;
    const sdk = window.LivekitClient;
    const participantId = participant.identity || "guest";
    const member = membersById().get(participantId);
    const label = isLocal ? identity.name + " · you" : (member ? member.name : participant.name || "Room guest");
    if (isScreenTrack(publication, sdk)) {
      ui.screenVideo.srcObject = new MediaStream([track.mediaStreamTrack]);
      ui.screenVideo.classList.remove("hidden");
      ui.screenBadge.classList.remove("hidden");
      ui.sharerName.textContent = isLocal ? "· you" : "· " + label;
      ui.screenVideo.play().catch(function () {});
      if (isLocal) liveKitScreenActive = true;
      return;
    }
    if (publication.kind === sdk.Track.Kind.Audio || track.kind === "audio") {
      if (isLocal) return;
      const key = participantId + ":" + (track.sid || publication.trackSid || "audio");
      if (liveKitAudio.has(key)) return;
      const audio = track.attach();
      audio.autoplay = true;
      audio.playsInline = true;
      audio.className = "sfu-audio";
      document.body.append(audio);
      audio.play().catch(function () {});
      liveKitAudio.set(key, { audio: audio, track: track });
      return;
    }
    if (publication.kind === sdk.Track.Kind.Video || track.kind === "video") {
      const stream = new MediaStream([track.mediaStreamTrack]);
      addTile(isLocal ? "local" : "peer:" + participantId, label, stream, isLocal);
    }
  }

  function removeLiveKitTrack(track, publication, participant) {
    if (!track || !publication || !window.LivekitClient) return;
    const participantId = participant.identity || "guest";
    const key = participantId + ":" + (track.sid || publication.trackSid || "audio");
    const audioEntry = liveKitAudio.get(key);
    if (audioEntry) {
      try { audioEntry.track.detach(audioEntry.audio); } catch (_) {}
      audioEntry.audio.remove();
      liveKitAudio.delete(key);
    }
    if (isScreenTrack(publication, window.LivekitClient)) {
      ui.screenVideo.pause();
      ui.screenVideo.srcObject = null;
      ui.screenVideo.classList.add("hidden");
      ui.screenBadge.classList.add("hidden");
      if (participantId === identity.userId) liveKitScreenActive = false;
    } else if (publication.kind === window.LivekitClient.Track.Kind.Video || track.kind === "video") {
      removeTile(participantId === identity.userId ? "local" : "peer:" + participantId);
    }
    renderVideoChatStatus();
  }

  async function openLiveKitCall(withCamera) {
    if (liveKitRoom || liveKitConnecting) return Boolean(liveKitRoom);
    liveKitConnecting = true;
    let roomConnection = null;
    try {
      const sdk = await loadLiveKitSdk();
      const tokenResponse = await fetch("/api/livekit-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_code: room.code }),
      });
      const tokenData = await tokenResponse.json().catch(function () { return {}; });
      if (!tokenResponse.ok) throw new Error(tokenData.detail || "The media room could not be opened.");
      roomConnection = new sdk.Room({ adaptiveStream: true, dynacast: true });
      const event = sdk.RoomEvent;
      roomConnection.on(event.TrackSubscribed, function (track, publication, participant) {
        mountLiveKitTrack(track, publication, participant, false);
      });
      roomConnection.on(event.TrackUnsubscribed, function (track, publication, participant) {
        removeLiveKitTrack(track, publication, participant);
      });
      roomConnection.on(event.LocalTrackPublished, function (publication) {
        if (publication.track) mountLiveKitTrack(publication.track, publication, roomConnection.localParticipant, true);
      });
      roomConnection.on(event.LocalTrackUnpublished, function (publication) {
        if (publication.track) removeLiveKitTrack(publication.track, publication, roomConnection.localParticipant);
      });
      roomConnection.on(event.ParticipantDisconnected, function (participant) {
        removeTile("peer:" + participant.identity);
        for (const [key, audioEntry] of liveKitAudio) {
          if (key.startsWith(participant.identity + ":")) {
            try { audioEntry.track.detach(audioEntry.audio); } catch (_) {}
            audioEntry.audio.remove();
            liveKitAudio.delete(key);
          }
        }
      });
      roomConnection.on(event.ConnectionStateChanged, function (connectionState) {
        ui.status.textContent = connectionState === "connected" ? "Connected through the media server" : "Media server · " + connectionState;
      });
      await roomConnection.connect(tokenData.server_url, tokenData.participant_token);
      liveKitRoom = roomConnection;
      try {
        await liveKitRoom.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true });
      } catch (_) { onToast("Microphone could not start; camera video may still work."); }
      if (withCamera) {
        try {
          await liveKitRoom.localParticipant.setCameraEnabled(true);
        } catch (_) { onToast("Camera could not start; you can still join with microphone audio."); }
      }
      const participant = liveKitRoom.localParticipant;
      participant.trackPublications.forEach(function (publication) {
        if (publication.track) mountLiveKitTrack(publication.track, publication, participant, true);
      });
      liveKitRoom.remoteParticipants.forEach(function (remote) {
        remote.trackPublications.forEach(function (publication) {
          if (publication.track) mountLiveKitTrack(publication.track, publication, remote, false);
        });
      });
      if (!sendAction("video.join", { media_mode: "sfu" })) {
        await closeLiveKitCall(false);
        return false;
      }
      ui.status.textContent = "Connected through the media server";
      return true;
    } catch (error) {
      if (roomConnection) roomConnection.disconnect();
      liveKitRoom = null;
      onToast(error && error.message ? error.message : "The group media service could not connect.");
      return false;
    } finally {
      liveKitConnecting = false;
      renderVideoChatStatus();
    }
  }

  async function closeLiveKitCall(sendLeave) {
    const activeRoom = liveKitRoom;
    liveKitRoom = null;
    if (sendLeave) sendAction("video.leave", {});
    if (activeRoom) activeRoom.disconnect();
    for (const [key, audioEntry] of liveKitAudio) {
      try { audioEntry.track.detach(audioEntry.audio); } catch (_) {}
      audioEntry.audio.remove();
      liveKitAudio.delete(key);
    }
    removeTile("local");
    for (const id of Array.from(tiles.keys())) if (id.startsWith("peer:")) removeTile(id);
    liveKitScreenActive = false;
    renderVideoChatStatus();
  }

  // Shared room media state and local device controls
  function renderVideoChatStatus() {
    const people = room && room.video_members || [];
    const inCall = people.includes(identity.userId);
    ui.dock.classList.toggle("hidden", people.length === 0 && !(room && room.screen_sharer));
    ui.count.textContent = people.length + (people.length === 1 ? " person" : " people");
    setMediaButtonLabel(ui.videoButton, inCall ? "micOff" : "mic", inCall ? "Leave voice" : "Join voice");
    ui.videoButton.classList.toggle("is-on", inCall);
    ui.micButton.classList.toggle("hidden", !inCall);
    ui.cameraButton.classList.toggle("hidden", !inCall);
    const memberIds = new Set(people);
    for (const [key, tile] of Array.from(tiles.entries())) {
      if (tile.memberId && !memberIds.has(tile.memberId)) removeTile(key);
    }
    people.forEach(function (memberId) {
      const isLocal = memberId === identity.userId;
      const key = isLocal ? "local" : "peer:" + memberId;
      if (!tiles.has(key) || tiles.get(key).isVoice) {
        const member = membersById().get(memberId);
        addVoiceTile(key, memberId, (isLocal ? identity.name + " · you" : member && member.name || "Room guest"), isLocal);
      }
    });
    if (!inCall && !localScreenStream && !(room && room.screen_sharer)) ui.status.textContent = "Film volume is yours; voice stays separate.";
    if (inCall && (localVideoStream || liveKitRoom)) {
      const audioEnabled = liveKitRoom ? liveKitRoom.localParticipant.isMicrophoneEnabled :
        Boolean(localVideoStream.getAudioTracks()[0] && localVideoStream.getAudioTracks()[0].enabled);
      const cameraEnabled = liveKitRoom ? liveKitRoom.localParticipant.isCameraEnabled :
        Boolean(localVideoStream.getVideoTracks()[0] && localVideoStream.getVideoTracks()[0].enabled);
      setMediaButtonLabel(ui.micButton, audioEnabled ? "mic" : "micOff", audioEnabled ? "Mic on" : "Mic off");
      setMediaButtonLabel(ui.cameraButton, cameraEnabled ? "cameraOff" : "camera", cameraEnabled ? "Turn camera off" : "Turn camera on");
      ui.micButton.classList.toggle("is-danger", !audioEnabled);
      ui.cameraButton.classList.toggle("is-danger", !cameraEnabled);
      ui.micButton.setAttribute("aria-pressed", String(audioEnabled));
      ui.cameraButton.setAttribute("aria-pressed", String(cameraEnabled));
    }
  }

  function syncRoom(nextRoom) {
    room = nextRoom;
    if (!room) return;
    const members = membersById();
    const connectedIds = new Set((room.members || []).filter(function (member) { return member.connected; }).map(function (member) { return member.id; }));
    const videoMembers = new Set(room.video_members || []);

    if (mediaMode === "sfu") {
      if (!room.screen_sharer && !liveKitScreenActive) {
        ui.screenVideo.pause();
        ui.screenVideo.srcObject = null;
        ui.screenVideo.classList.add("hidden");
        ui.screenBadge.classList.add("hidden");
      } else if (room.screen_sharer && room.screen_sharer !== identity.userId && !ui.screenVideo.srcObject) {
        const sharer = members.get(room.screen_sharer);
        ui.sharerName.textContent = sharer ? "· " + sharer.name : "";
        ui.screenBadge.classList.remove("hidden");
        ui.status.textContent = "Connecting to the shared screen…";
      }
      const sharing = Boolean(room.screen_sharer);
      ui.shareButton.classList.toggle("hidden", room.screen_sharer === identity.userId);
      ui.stopShareButton.classList.toggle("hidden", room.screen_sharer !== identity.userId);
      ui.shareButton.disabled = sharing && room.screen_sharer !== identity.userId;
      ui.shareButton.textContent = sharing && room.screen_sharer !== identity.userId ? "Screen is being shared" : "▱ Share screen";
      renderVideoChatStatus();
      return;
    }

    if (localVideoStream && !videoMembers.has(identity.userId) && socket && socket.readyState === WebSocket.OPEN) {
      sendAction("video.join", {});
    }

    for (const entry of Array.from(peers.values())) {
      const expected = entry.channel === "video" ?
        videoMembers.has(identity.userId) && videoMembers.has(entry.remoteId) :
        Boolean(room.screen_sharer) && (room.screen_sharer === identity.userId ? connectedIds.has(entry.remoteId) : entry.remoteId === room.screen_sharer);
      if (!expected) closePeer(entry.key);
    }

    if (videoMembers.has(identity.userId) && localVideoStream) {
      videoMembers.forEach(function (memberId) {
        if (memberId !== identity.userId && connectedIds.has(memberId)) peerFor(memberId, "video");
      });
    }

    if (room.screen_sharer === identity.userId && localScreenStream) {
      pendingScreenStart = false;
      connectedIds.forEach(function (memberId) {
        if (memberId !== identity.userId) peerFor(memberId, "screen");
      });
      ui.screenVideo.srcObject = localScreenStream;
      ui.screenVideo.classList.remove("hidden");
      ui.screenBadge.classList.remove("hidden");
      ui.sharerName.textContent = "· you";
      ui.status.textContent = "You are sharing your screen";
    } else if (room.screen_sharer && room.screen_sharer !== identity.userId) {
      pendingScreenStart = false;
      if (localScreenStream) stopLocalScreen(false);
      const sharer = members.get(room.screen_sharer);
      ui.sharerName.textContent = sharer ? "· " + sharer.name : "";
      ui.screenBadge.classList.remove("hidden");
      if (!ui.screenVideo.srcObject) ui.status.textContent = "Connecting to the shared screen…";
    } else {
      if (localScreenStream && !pendingScreenStart) stopLocalScreen(false);
      ui.screenVideo.pause();
      ui.screenVideo.srcObject = null;
      ui.screenVideo.classList.add("hidden");
      ui.screenBadge.classList.add("hidden");
    }

    const sharing = Boolean(room.screen_sharer);
    ui.shareButton.classList.toggle("hidden", room.screen_sharer === identity.userId);
    ui.stopShareButton.classList.toggle("hidden", room.screen_sharer !== identity.userId);
    ui.shareButton.disabled = sharing && room.screen_sharer !== identity.userId;
    ui.shareButton.textContent = sharing && room.screen_sharer !== identity.userId ? "Screen is being shared" : "▱ Share screen";
    renderVideoChatStatus();
  }

  async function startVideoChat(withCamera) {
    withCamera = Boolean(withCamera);
    if (localVideoStream || localMediaStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onToast("Voice chat needs a secure page (HTTPS or localhost) and a supported browser.");
      return;
    }
    if (mediaMode === "sfu") {
      await openLiveKitCall(withCamera);
      return;
    }
    if (room && (room.video_members || []).filter(function (id) { return id !== identity.userId; }).length >= 4) {
      onToast("Peer-to-peer voice calls are limited to four people. Configure the LiveKit SFU for larger calls.");
      return;
    }
    localMediaStarting = true;
    try {
      localVideoStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: withCamera ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 12, max: 15 } } : false,
      });
      if (withCamera) addTile("local", identity.name + " · you", localVideoStream, true);
      ui.status.textContent = withCamera ? "Connecting your camera and mic…" : "Connecting your microphone…";
      sendAction("video.join", { media_mode: mediaMode === "sfu" ? "sfu" : "mesh" });
    } catch (error) {
      localVideoStream = null;
      onToast(error && error.name === "NotAllowedError" ? "Allow microphone access to join voice chat." : "The microphone could not start.");
    } finally {
      localMediaStarting = false;
    }
  }

  function stopLocalVideo(sendLeave) {
    if (liveKitRoom) {
      closeLiveKitCall(sendLeave);
      return;
    }
    if (sendLeave) sendAction("video.leave", {});
    if (localVideoStream) localVideoStream.getTracks().forEach(function (track) { track.stop(); });
    localVideoStream = null;
    removeTile("local");
    for (const entry of Array.from(peers.values())) if (entry.channel === "video") closePeer(entry.key);
    renderVideoChatStatus();
  }

  function stopLocalScreen(sendStop) {
    pendingScreenStart = false;
    if (mediaMode === "sfu" && liveKitRoom) {
      if (sendStop && room && room.screen_sharer === identity.userId) sendAction("screen.stop", {});
      liveKitScreenActive = false;
      liveKitRoom.localParticipant.setScreenShareEnabled(false).catch(function () {});
      ui.screenVideo.pause();
      ui.screenVideo.srcObject = null;
      ui.screenVideo.classList.add("hidden");
      ui.screenBadge.classList.add("hidden");
      return;
    }
    if (sendStop && localScreenStream) sendAction("screen.stop", {});
    if (localScreenStream) localScreenStream.getTracks().forEach(function (track) { track.onended = null; track.stop(); });
    localScreenStream = null;
    for (const entry of Array.from(peers.values())) if (entry.channel === "screen") closePeer(entry.key);
    ui.screenVideo.pause();
    ui.screenVideo.srcObject = null;
    ui.screenVideo.classList.add("hidden");
    ui.screenBadge.classList.add("hidden");
    if (room && room.screen_sharer === identity.userId) ui.status.textContent = "Stopping screen share…";
  }

  function getScreenShareUnavailableMessage() {
    if (!window.isSecureContext) {
      return "Screen sharing requires a secure HTTPS page. Open the room using its HTTPS link.";
    }

    const permissionsPolicy = document.permissionsPolicy || document.featurePolicy;
    if (permissionsPolicy && typeof permissionsPolicy.allowsFeature === "function" &&
        !permissionsPolicy.allowsFeature("display-capture")) {
      return "Your browser blocks screen capture on this page. Open the HTTPS room directly in a browser tab.";
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      return "This browser does not support screen sharing here. Open the HTTPS room directly in a current desktop browser; in-app browsers and some phones do not offer screen capture.";
    }

    return "";
  }

  async function startScreenShare() {
    const unavailableMessage = getScreenShareUnavailableMessage();
    if (unavailableMessage) {
      onToast(unavailableMessage);
      return;
    }
    if (room && room.screen_sharer) {
      onToast("Wait for the current screen share to end first.");
      return;
    }
    if (mediaMode === "sfu") {
      if (!liveKitRoom) {
        onToast("Join voice first, then start your screen share.");
        return;
      }
      pendingScreenStart = true;
      if (!sendAction("screen.start", { media_mode: "sfu" })) { pendingScreenStart = false; return; }
      try {
        await liveKitRoom.localParticipant.setScreenShareEnabled(true, {
          audio: true,
          systemAudio: "include",
        });
        ui.status.textContent = "Sharing through the media server";
        if (!hasLiveKitScreenAudio()) {
          onToast("Screen video is live, but no sound was shared. Choose the tab playing the video and enable tab audio in the browser picker.");
        }
      } catch (_) {
        pendingScreenStart = false;
        sendAction("screen.stop", {});
        onToast("The browser could not start screen sharing.");
      }
      return;
    }
    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 20, max: 30 } },
        audio: true,
        systemAudio: "include",
      });
      if (!localScreenStream.getAudioTracks().length) {
        onToast("Screen video is live, but no sound was shared. Choose the tab playing the video and enable tab audio in the browser picker.");
      }
      const track = localScreenStream.getVideoTracks()[0];
      if (track) track.onended = function () { stopLocalScreen(true); };
      pendingScreenStart = true;
      ui.screenVideo.srcObject = localScreenStream;
      ui.screenVideo.classList.remove("hidden");
      ui.screenBadge.classList.remove("hidden");
      ui.sharerName.textContent = "· you";
      if (!sendAction("screen.start", { media_mode: "mesh" })) {
        stopLocalScreen(false);
        return;
      }
      ui.status.textContent = "Starting live screen share…";
    } catch (error) {
      localScreenStream = null;
      if (error && error.name !== "NotAllowedError") onToast("The browser could not start screen sharing.");
    }
  }

  function toggleTrack(kind) {
    if (liveKitRoom) {
      const participant = liveKitRoom.localParticipant;
      const toggle = kind === "audio" ? participant.setMicrophoneEnabled(!participant.isMicrophoneEnabled) :
        participant.setCameraEnabled(!participant.isCameraEnabled);
      Promise.resolve(toggle).then(renderVideoChatStatus).catch(function () { onToast("That media device could not be changed."); });
      return;
    }
    if (!localVideoStream) return;
    const tracks = kind === "audio" ? localVideoStream.getAudioTracks() : localVideoStream.getVideoTracks();
    if (!tracks.length && kind === "video") {
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 12, max: 15 } } })
        .then(function (cameraStream) {
          const cameraTrack = cameraStream.getVideoTracks()[0];
          if (!cameraTrack) return;
          localVideoStream.addTrack(cameraTrack);
          peers.forEach(function (entry) {
            if (entry.channel === "video" && entry.pc.signalingState !== "closed") entry.pc.addTrack(cameraTrack, localVideoStream);
          });
          addTile("local", identity.name + " · you", localVideoStream, true);
          renderVideoChatStatus();
        })
        .catch(function (error) { onToast(error && error.name === "NotAllowedError" ? "Allow camera access to turn your camera on." : "The camera could not start."); });
      return;
    }
    if (!tracks.length) return;
    if (kind === "video") {
      const cameraTrack = tracks[0];
      peers.forEach(function (entry) {
        if (entry.channel !== "video" || entry.pc.signalingState === "closed") return;
        entry.pc.getSenders().forEach(function (sender) {
          if (sender.track === cameraTrack) entry.pc.removeTrack(sender);
        });
      });
      localVideoStream.removeTrack(cameraTrack);
      cameraTrack.stop();
      removeTile("local");
      renderVideoChatStatus();
      return;
    }
    tracks[0].enabled = !tracks[0].enabled;
    renderVideoChatStatus();
  }

  // Public controls used by the main app
  window.WatchPartyMedia = {
    configure: function (options) {
      identity = { userId: options.userId, name: options.name };
      sendAction = options.sendAction;
      onToast = options.onToast;
    },
    refreshConfig: refreshConfig,
    setSocket: function (nextSocket) { socket = nextSocket; },
    syncRoom: syncRoom,
    handleSignal: function (message) {
      if (mediaMode === "sfu") return;
      receiveSignal(message).catch(function (error) { console.warn("Media signal was ignored", error); });
    },
    startVideoChat: startVideoChat,
    leaveVideoChat: function () { stopLocalVideo(true); },
    startScreenShare: startScreenShare,
    stopScreenShare: function () { stopLocalScreen(true); },
    handleServerError: function () {
      if (mediaMode === "sfu" && liveKitRoom && liveKitScreenActive && (!room || room.screen_sharer !== identity.userId)) {
        stopLocalScreen(false);
        ui.status.textContent = "Screen share could not start";
      }
      if (localScreenStream && (!room || room.screen_sharer !== identity.userId)) {
        pendingScreenStart = false;
        stopLocalScreen(false);
        ui.status.textContent = "Screen share could not start";
      }
    },
    toggleMic: function () { toggleTrack("audio"); },
    toggleCamera: function () { toggleTrack("video"); },
    disconnect: function () {
      stopLocalVideo(false);
      stopLocalScreen(false);
      for (const entry of Array.from(peers.values())) closePeer(entry.key);
      socket = null;
      room = null;
    },
  };
})();
