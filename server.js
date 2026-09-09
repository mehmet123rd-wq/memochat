const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 50 * 1024 * 1024
});

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});

app.use('/peerjs', peerServer);
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const USERS_FILE = path.join(__dirname, 'users.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const MEDIA_ARCHIVE_FILE = path.join(__dirname, 'media_archive.json');
const CHAT_HISTORY_FILE = path.join(__dirname, 'chat_history.json');

let usersData = {};
let channelsData = {
  "Genel Kanal": { owner: "Sistem", type: "Ses Kanalı", password: "", locked: false, maxCapacity: 50, allowedUsers: [], subChannels: [], channelRoles: {} }
};
let mediaArchive = {};
let activeUsers = {};
let roomChatHistory = {};
let roomWatchPartyPolls = {};
let roomActiveMusic = {};

function findChannelData(channelName) {
  if (channelsData[channelName]) return { data: channelsData[channelName], parentKey: channelName, isMain: true };
  for (let mainKey in channelsData) {
    const subs = channelsData[mainKey].subChannels || [];
    const subMatch = subs.find(s => s.name === channelName);
    if (subMatch) {
      return {
        data: {
          ...subMatch,
          password: subMatch.password !== undefined ? subMatch.password : channelsData[mainKey].password,
          locked: subMatch.locked !== undefined ? subMatch.locked : (channelsData[mainKey].locked || false),
          maxCapacity: subMatch.maxCapacity !== undefined ? subMatch.maxCapacity : (channelsData[mainKey].maxCapacity || 50),
          allowedUsers: subMatch.allowedUsers || channelsData[mainKey].allowedUsers || [],
          channelRoles: channelsData[mainKey].channelRoles || {}
        },
        parentKey: mainKey,
        isMain: false
      };
    }
  }
  return null;
}

function loadData() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } else {
      usersData["admin"] = {
        password: "123",
        approved: true,
        banned: false,
        banType: null,
        avatar: "",
        status: "Sistem Yöneticisi",
        banner: "",
        birthday: "",
        bio: "",
        friends: [],
        friendRequests: [],
        joinedChannels: ["Genel Kanal"]
      };
      usersData["memo"] = {
        password: "123",
        approved: true,
        banned: false,
        banType: null,
        avatar: "",
        status: "Uygulama Sahibi",
        banner: "",
        birthday: "",
        bio: "",
        friends: [],
        friendRequests: [],
        joinedChannels: ["Genel Kanal"]
      };
      saveUsers();
    }

    if (fs.existsSync(CHANNELS_FILE)) {
      channelsData = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    } else {
      saveChannels();
    }

    if (fs.existsSync(MEDIA_ARCHIVE_FILE)) {
      mediaArchive = JSON.parse(fs.readFileSync(MEDIA_ARCHIVE_FILE, 'utf8'));
    }

    if (fs.existsSync(CHAT_HISTORY_FILE)) {
      roomChatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error("Veri yükleme hatası:", e);
  }
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2)); } catch (e) {}
}

function saveChannels() {
  try { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channelsData, null, 2)); } catch (e) {}
}

function saveMediaArchive() {
  try { fs.writeFileSync(MEDIA_ARCHIVE_FILE, JSON.stringify(mediaArchive, null, 2)); } catch (e) {}
}

function saveChatHistory() {
  try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(roomChatHistory, null, 2)); } catch (e) {}
}

loadData();

io.on('connection', (socket) => {
  socket.on('register-user', (data) => {
    const { username, password } = data;
    if (!username || !password) {
      socket.emit('register-result', { success: false, message: "Kullanıcı adı ve şifre zorunludur!" });
      return;
    }
    if (usersData[username]) {
      socket.emit('register-result', { success: false, message: "Bu kullanıcı adı zaten alınmış!" });
      return;
    }

    usersData[username] = {
      password: password,
      approved: false,
      banned: false,
      banType: null,
      avatar: "",
      status: "Yeni Üye",
      banner: "",
      birthday: "",
      bio: "",
      friends: [],
      friendRequests: [],
      joinedChannels: ["Genel Kanal"]
    };
    saveUsers();

    socket.emit('register-result', { success: true, message: "Kayıt başarılı! Yönetici onayından sonra giriş yapabilirsin." });
    io.emit('new-pending-user', username);
  });

  socket.on('auth-check', (data) => {
    const { username, password } = data;
    const user = usersData[username];

    if (!user || user.password !== password) {
      socket.emit('auth-result', { success: false, message: "Geçersiz kullanıcı adı veya şifre!" });
      return;
    }

    if (user.banned) {
      socket.emit('auth-result', { success: false, message: "Bu hesap banlanmıştır!" });
      return;
    }

    if (!user.approved && username.toLowerCase() !== 'admin' && username.toLowerCase() !== 'memo') {
      socket.emit('auth-result', { success: false, message: "Hesabınız henüz yönetici tarafından onaylanmamış!" });
      return;
    }

    const isAdmin = (username.toLowerCase() === 'admin' || username.toLowerCase() === 'memo');
    let pendingUsers = [];
    if (isAdmin) {
      pendingUsers = Object.keys(usersData).filter(u => !usersData[u].approved);
    }

    socket.emit('auth-result', {
      success: true,
      isAdmin: isAdmin,
      avatar: user.avatar,
      status: user.status,
      banner: user.banner,
      birthday: user.birthday,
      bio: user.bio,
      friends: user.friends || [],
      friendRequests: user.friendRequests || [],
      joinedChannels: user.joinedChannels || ["Genel Kanal"],
      channels: channelsData,
      pendingUsers: pendingUsers,
      allUsers: usersData
    });
  });

  socket.on('approve-user', (data) => {
    const { adminUser, targetUser } = data;
    if ((adminUser.toLowerCase() === 'admin' || adminUser.toLowerCase() === 'memo') && usersData[targetUser]) {
      usersData[targetUser].approved = true;
      saveUsers();
      io.emit('user-approved', targetUser);
    }
  });

  socket.on('ban-user-timed', (data) => {
    const { adminUser, targetUser, duration } = data;
    if ((adminUser.toLowerCase() === 'admin' || adminUser.toLowerCase() === 'memo') && usersData[targetUser]) {
      usersData[targetUser].banned = true;
      usersData[targetUser].banType = duration;
      saveUsers();
      io.emit('user-banned', targetUser);
    }
  });

  socket.on('unban-user', (data) => {
    const { adminUser, targetUser } = data;
    if ((adminUser.toLowerCase() === 'admin' || adminUser.toLowerCase() === 'memo') && usersData[targetUser]) {
      usersData[targetUser].banned = false;
      usersData[targetUser].banType = null;
      saveUsers();
      io.emit('update-channels', channelsData);
    }
  });

  socket.on('join-room', (roomId, peerId, username) => {
    socket.join(roomId);

    if (!activeUsers[roomId]) activeUsers[roomId] = [];
    if (!activeUsers[roomId].includes(username)) {
      activeUsers[roomId].push(username);
    }

    if (!roomChatHistory[roomId]) roomChatHistory[roomId] = [];
    socket.emit('load-chat-history', roomChatHistory[roomId]);

    if (roomActiveMusic[roomId]) {
      socket.emit('bot-play-music', roomActiveMusic[roomId]);
    }

    io.to(roomId).emit('update-active-users', activeUsers);
    socket.to(roomId).emit('user-connected', peerId, username, usersData[username]?.avatar || "");

    socket.on('disconnect', () => {
      if (activeUsers[roomId]) {
        activeUsers[roomId] = activeUsers[roomId].filter(u => u !== username);
        if (activeUsers[roomId].length === 0) delete activeUsers[roomId];
      }
      io.to(roomId).emit('update-active-users', activeUsers);
      socket.to(roomId).emit('user-disconnected', peerId);
    });
  });

  socket.on('create-channel', (data) => {
    const { creatorUser, channelName, channelPassword, channelType, maxCapacity } = data;
    if (!channelName) {
      socket.emit('channel-create-result', { success: false, message: "Dünya adı boş olamaz!" });
      return;
    }
    if (channelsData[channelName] || findChannelData(channelName)) {
      socket.emit('channel-create-result', { success: false, message: "Bu isimde bir dünya veya kanal zaten var!" });
      return;
    }

    const capacity = parseInt(maxCapacity) || 50;

    channelsData[channelName] = {
      owner: creatorUser,
      type: channelType || 'Ses Kanalı',
      password: channelPassword || "",
      locked: false,
      maxCapacity: capacity,
      allowedUsers: [creatorUser],
      subChannels: [],
      channelRoles: { [creatorUser]: "Kanal Sahibi" }
    };
    saveChannels();

    if (usersData[creatorUser] && !usersData[creatorUser].joinedChannels.includes(channelName)) {
      usersData[creatorUser].joinedChannels.push(channelName);
      saveUsers();
    }

    socket.emit('channel-create-result', { success: true });
    io.emit('update-channels', channelsData);
  });

  socket.on('create-sub-channel', (data) => {
    const { parentChannel, subChannelName, subChannelType, maxCapacity, requestingUser } = data;
    if (!channelsData[parentChannel]) {
      socket.emit('sub-channel-result', { success: false, message: "Ana kanal bulunamadı!" });
      return;
    }

    if (findChannelData(subChannelName)) {
      socket.emit('sub-channel-result', { success: false, message: "Bu isimde bir kanal zaten var!" });
      return;
    }

    const capacity = parseInt(maxCapacity) || 50;

    channelsData[parentChannel].subChannels.push({
      name: subChannelName,
      type: subChannelType,
      owner: requestingUser,
      locked: false,
      maxCapacity: capacity,
      allowedUsers: [requestingUser]
    });
    saveChannels();
    io.emit('update-channels', channelsData);
    socket.emit('sub-channel-result', { success: true });
  });

  socket.on('toggle-channel-lock', (data) => {
    const { channelName, requestingUser } = data;
    const resObj = findChannelData(channelName);
    if (!resObj) return;
    const ch = resObj.data;

    const isOwner = (ch.owner === requestingUser || requestingUser === 'admin' || requestingUser === 'memo');
    if (!isOwner) {
      socket.emit('channel-lock-result', { success: false, message: "Odayı kilitleme yetkiniz yok!" });
      return;
    }

    if (resObj.isMain) {
      channelsData[channelName].locked = !channelsData[channelName].locked;
    } else {
      const sub = channelsData[resObj.parentKey].subChannels.find(s => s.name === channelName);
      if (sub) sub.locked = !sub.locked;
    }
    saveChannels();
    io.emit('update-channels', channelsData);
    socket.emit('channel-lock-result', { success: true });
  });

  socket.on('verify-channel-password', (data) => {
    const { channelName, password, username } = data;
    const resObj = findChannelData(channelName);
    if (!resObj) {
      socket.emit('channel-auth-result', { success: false, message: "Kanal bulunamadı!" });
      return;
    }
    const ch = resObj.data;

    // --- KONTENJAN KONTROLÜ ---
    const currentActiveCount = activeUsers[channelName]?.length || 0;
    const isAlreadyIn = activeUsers[channelName]?.includes(username);
    if (!isAlreadyIn && currentActiveCount >= (ch.maxCapacity || 50)) {
      socket.emit('channel-auth-result', { success: false, message: `Bu oda dolu! Maksimum kişi sınırı (${ch.maxCapacity}) dolmuştur.` });
      return;
    }

    const isOwner = (ch.owner === username || username === 'admin' || username === 'memo');
    const userRole = (resObj.isMain ? channelsData[resObj.parentKey].channelRoles?.[username] : channelsData[resObj.parentKey].channelRoles?.[username]) || (isOwner ? "Kanal Sahibi" : "Üye");
    const isAllowed = ch.allowedUsers && ch.allowedUsers.includes(username);

    if (ch.locked && !isOwner && userRole !== 'Moderatör' && !isAllowed) {
      socket.emit('channel-auth-result', { success: false, message: "Bu oda kilitli! İçeri girmek için yetki gerekiyor." });
      return;
    }

    if (!ch.password || ch.password === "" || ch.password === password) {
      if (usersData[username] && !usersData[username].joinedChannels.includes(channelName)) {
        usersData[username].joinedChannels.push(channelName);
        saveUsers();
      }
      socket.emit('channel-auth-result', { success: true });
    } else {
      socket.emit('channel-auth-result', { success: false, message: "Hatalı kanal şifresi!" });
    }
  });

  socket.on('send-poke-notification', (data) => {
    const { roomId, username, messageText } = data;
    socket.to(roomId).emit('receive-poke-notification', {
      sender: username,
      messageText: messageText
    });
  });

  socket.on('play-music-request', (data) => {
    const { roomId, query, username, channelType } = data;
    if (channelType === 'Metin Kanalı') return;

    let videoId = "jfKfPfyJRdk";
    if (query.includes('youtube.com/watch?v=')) {
      videoId = query.split('watch?v=')[1].split('&')[0];
    } else if (query.includes('youtu.be/')) {
      videoId = query.split('youtu.be/')[1].split('?')[0];
    }

    const musicData = { query: query, videoId: videoId, requestedBy: username };
    roomActiveMusic[roomId] = musicData;
    io.to(roomId).emit('bot-play-music', musicData);
  });

  socket.on('stop-music-request', (data) => {
    const { roomId, username } = data;
    delete roomActiveMusic[roomId];
    io.to(roomId).emit('bot-stop-music', { stoppedBy: username });
  });

  socket.on('clear-channel-messages', (data) => {
    const { channelName, duration, requestingUser } = data;
    const resObj = findChannelData(channelName);
    if (!resObj) return;
    const ch = resObj.data;

    const isOwner = (ch.owner === requestingUser || requestingUser === 'admin' || requestingUser === 'memo');
    if (!isOwner) {
      socket.emit('clear-messages-result', { success: false, message: "Yetkiniz yok!" });
      return;
    }

    if (roomChatHistory[channelName]) {
      const now = Date.now();
      if (duration === '1day') {
        const limit = now - (24 * 60 * 60 * 1000);
        roomChatHistory[channelName] = roomChatHistory[channelName].filter(m => m.timestamp && m.timestamp > limit);
      } else if (duration === '1week') {
        const limit = now - (7 * 24 * 60 * 60 * 1000);
        roomChatHistory[channelName] = roomChatHistory[channelName].filter(m => m.timestamp && m.timestamp > limit);
      } else if (duration === 'all') {
        roomChatHistory[channelName] = [];
      }
      saveChatHistory();
      io.to(channelName).emit('load-chat-history', roomChatHistory[channelName]);
    }
    socket.emit('clear-messages-result', { success: true, message: "Mesajlar temizlendi!" });
  });

  socket.on('delete-channel', (data) => {
    const { channelName, requestingUser } = data;
    if (channelsData[channelName]) {
      const ch = channelsData[channelName];
      const isOwner = (ch.owner === requestingUser || requestingUser === 'admin' || requestingUser === 'memo');
      if (!isOwner) {
        socket.emit('channel-delete-result', { success: false, message: "Yetkiniz yok!" });
        return;
      }
      delete channelsData[channelName];
      delete roomChatHistory[channelName];
      delete roomActiveMusic[channelName];
    } else {
      let foundSub = false;
      for (let mainKey in channelsData) {
        if (channelsData[mainKey].subChannels) {
          const subIndex = channelsData[mainKey].subChannels.findIndex(s => s.name === channelName);
          if (subIndex !== -1) {
            const subObj = channelsData[mainKey].subChannels[subIndex];
            const isOwner = (subObj.owner === requestingUser || requestingUser === 'admin' || requestingUser === 'memo');
            if (!isOwner) {
              socket.emit('channel-delete-result', { success: false, message: "Yetkiniz yok!" });
              return;
            }
            channelsData[mainKey].subChannels.splice(subIndex, 1);
            foundSub = true;
            break;
          }
        }
      }
      if (!foundSub) return;
      delete roomChatHistory[channelName];
      delete roomActiveMusic[channelName];
    }
    saveChannels();
    saveChatHistory();
    io.emit('update-channels', channelsData);
    socket.emit('channel-delete-result', { success: true });
  });

  socket.on('assign-channel-role', (data) => {
    const { channelName, targetUser, newRole, requestingUser } = data;
    const resObj = findChannelData(channelName);
    if (!resObj) return;
    const ch = resObj.data;

    const isOwner = (ch.owner === requestingUser || requestingUser === 'admin' || requestingUser === 'memo');
    if (!isOwner) {
      socket.emit('channel-role-result', { success: false, message: "Yetkiniz yok!" });
      return;
    }

    if (!channelsData[resObj.parentKey].channelRoles) channelsData[resObj.parentKey].channelRoles = {};
    channelsData[resObj.parentKey].channelRoles[targetUser] = newRole;
    saveChannels();

    io.emit('update-channels', channelsData);
    io.emit('channel-role-updated', { channelName, targetUser, newRole });
    socket.emit('channel-role-result', { success: true, message: "Rol atandı!" });
  });

  socket.on('trigger-birthday-celebration', (data) => {
    const { adminUser } = data;
    if (adminUser.toLowerCase() === 'admin' || adminUser.toLowerCase() === 'memo') {
      io.emit('run-birthday-celebration-client');
    }
  });

  socket.on('request-close-watch-party', (data) => {
    const { roomId, username } = data;
    io.to(roomId).emit('trigger-watch-party-poll', { requestedBy: username });
  });

  socket.on('vote-watch-party-poll', (data) => {
    const { roomId, vote, username } = data;
    if (!roomWatchPartyPolls[roomId]) {
      roomWatchPartyPolls[roomId] = { votes: {}, totalUsers: activeUsers[roomId]?.length || 1 };
    }
    roomWatchPartyPolls[roomId].votes[username] = vote;
    const currentVotes = roomWatchPartyPolls[roomId].votes;
    const votedCount = Object.keys(currentVotes).length;
    const totalCount = roomWatchPartyPolls[roomId].totalUsers;

    if (votedCount >= totalCount) {
      let closeCount = 0;
      let continueCount = 0;
      for (let u in currentVotes) {
        if (currentVotes[u] === 'close') closeCount++;
        else continueCount++;
      }
      let resultAction = closeCount > continueCount ? 'close' : 'continue';
      io.to(roomId).emit('watch-party-poll-result', { action: resultAction, closeCount, continueCount });
      delete roomWatchPartyPolls[roomId];
    }
  });

  socket.on('send-message', (data) => {
    const { roomId, user, avatar, message, file, poll } = data;
    const msgObj = { user, avatar, message, file, poll, timestamp: Date.now() };

    if (!roomChatHistory[roomId]) roomChatHistory[roomId] = [];
    roomChatHistory[roomId].push(msgObj);
    saveChatHistory();

    if (file) {
      if (!mediaArchive[roomId]) mediaArchive[roomId] = [];
      mediaArchive[roomId].push({ user, file, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      saveMediaArchive();
    }

    io.to(roomId).emit('receive-message', msgObj);
  });

  socket.on('vote-poll', (data) => {
    const { roomId, pollId, optionIndex, username } = data;
    const history = roomChatHistory[roomId];
    if (!history) return;

    const msg = history.find(m => m.poll && m.poll.id === pollId);
    if (msg && msg.poll) {
      msg.poll.options.forEach((opt, idx) => {
        opt.voters = opt.voters || [];
        const hasVotedIdx = opt.voters.indexOf(username);
        if (hasVotedIdx !== -1) {
          opt.voters.splice(hasVotedIdx, 1);
          opt.votes = Math.max(0, opt.votes - 1);
        }
        if (idx === optionIndex) {
          opt.voters.push(username);
          opt.votes++;
        }
      });
      saveChatHistory();
      io.to(roomId).emit('load-chat-history', history);
    }
  });

  socket.on('get-media-archive', (data) => {
    const { roomId } = data;
    socket.emit('media-archive-response', mediaArchive[roomId] || []);
  });

  socket.on('play-soundboard', (data) => {
    socket.to(data.roomId).emit('trigger-soundboard', data);
  });

  socket.on('typing', (data) => { socket.to(data.roomId).emit('user-typing', data); });
  socket.on('stop-typing', (data) => { socket.to(data.roomId).emit('user-stop-typing', data); });

  socket.on('update-status', (data) => {
    if (usersData[data.username]) {
      usersData[data.username].status = data.status;
      saveUsers();
      socket.broadcast.emit('user-status-changed', data);
    }
  });

  socket.on('update-avatar', (data) => {
    if (usersData[data.username]) {
      usersData[data.username].avatar = data.avatar;
      saveUsers();
      socket.broadcast.emit('user-avatar-changed', data);
    }
  });

  socket.on('update-profile-details', (data) => {
    const { username, banner, birthday, bio } = data;
    if (usersData[username]) {
      usersData[username].banner = banner;
      usersData[username].birthday = birthday;
      usersData[username].bio = bio;
      saveUsers();
    }
  });

  socket.on('sync-video-action', (data) => {
    socket.to(data.roomId).emit('receive-video-sync', data);
  });

  socket.on('send-friend-request', (data) => {
    const { sender, targetUser } = data;
    if (usersData[targetUser]) {
      if (!usersData[targetUser].friendRequests) usersData[targetUser].friendRequests = [];
      if (!usersData[targetUser].friendRequests.includes(sender)) {
        usersData[targetUser].friendRequests.push(sender);
        saveUsers();
        io.emit('friend-request-received', { sender, targetUser });
        socket.emit('friend-action-result', { success: true, message: "İstek gönderildi!" });
      } else {
        socket.emit('friend-action-result', { success: false, message: "Zaten istek gönderilmiş!" });
      }
    } else {
      socket.emit('friend-action-result', { success: false, message: "Kullanıcı bulunamadı!" });
    }
  });

  socket.on('respond-friend-request', (data) => {
    const { username, sender, accept } = data;
    const u = usersData[username];
    const s = usersData[sender];

    if (u && u.friendRequests) {
      u.friendRequests = u.friendRequests.filter(req => req !== sender);
      if (accept) {
        if (!u.friends) u.friends = [];
        if (!u.friends.includes(sender)) u.friends.push(sender);

        if (s) {
          if (!s.friends) s.friends = [];
          if (!s.friends.includes(username)) s.friends.push(username);
        }
      }
      saveUsers();
      socket.emit('friend-response-result', { success: true, friends: u.friends, requests: u.friendRequests });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MemoChat Sunucusu http://localhost:${PORT} adresinde çalışıyor...`);
});