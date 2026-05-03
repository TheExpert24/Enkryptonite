const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'call-state.json');
const PARTICIPANT_TTL_MS = 25 * 1000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let state = { rooms: {} };

function readState() {
  if (!fs.existsSync(DATA_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.rooms === 'object' && parsed.rooms !== null) {
      state = { rooms: parsed.rooms };
    }
  } catch (error) {
    console.error('Failed to read call data:', error.message);
  }
}

function writeState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function makeId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeRoomId(value) {
  return normalizeText(value).replace(/\s+/g, '-').toLowerCase();
}

function ensureRoom(roomId) {
  if (!state.rooms[roomId]) {
    state.rooms[roomId] = {
      id: roomId,
      createdAt: Date.now(),
      participants: {},
      signals: []
    };
  }

  const room = state.rooms[roomId];
  if (!room.participants || typeof room.participants !== 'object') {
    room.participants = {};
  }
  if (!Array.isArray(room.signals)) {
    room.signals = [];
  }

  return room;
}

function activeParticipants(room) {
  return Object.values(room.participants || {}).filter((participant) => Date.now() - participant.lastSeen <= PARTICIPANT_TTL_MS);
}

function pruneRoom(room) {
  const cutoff = Date.now() - PARTICIPANT_TTL_MS;
  Object.entries(room.participants || {}).forEach(([participantId, participant]) => {
    if (!participant || participant.lastSeen < cutoff) {
      delete room.participants[participantId];
    }
  });

  room.signals = (room.signals || []).filter((signal) => Date.now() - signal.createdAt <= ROOM_TTL_MS);
}

function pruneState() {
  Object.entries(state.rooms).forEach(([roomId, room]) => {
    pruneRoom(room);
    const isEmpty = activeParticipants(room).length === 0;
    const tooOld = Date.now() - room.createdAt > ROOM_TTL_MS;
    if (isEmpty && tooOld) {
      delete state.rooms[roomId];
    }
  });
}

function roomSummary(room) {
  const participants = activeParticipants(room).map((participant) => ({
    id: participant.id,
    name: participant.name,
    role: participant.role,
    joinedAt: participant.joinedAt,
    lastSeen: participant.lastSeen
  }));

  return {
    id: room.id,
    createdAt: room.createdAt,
    participantCount: participants.length,
    participants
  };
}

function getRoomAndParticipant(roomId, participantId) {
  const room = state.rooms[roomId];
  if (!room) {
    return { room: null, participant: null };
  }
  const participant = room.participants[participantId] || null;
  return { room, participant };
}

readState();
pruneState();
writeState();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scribbles.html'));
});

app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const room = state.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  pruneRoom(room);
  writeState();
  res.json({ room: roomSummary(room) });
});

app.post('/api/rooms/join', (req, res) => {
  const roomId = normalizeRoomId(req.body.roomId);
  const name = normalizeText(req.body.name);
  const requestedParticipantId = normalizeText(req.body.participantId);

  if (!roomId || !name) {
    return res.status(400).json({ error: 'Room ID and name are required' });
  }

  const room = ensureRoom(roomId);
  pruneRoom(room);

  let participant = requestedParticipantId ? room.participants[requestedParticipantId] : null;
  if (!participant && Object.keys(room.participants).length >= 2) {
    return res.status(409).json({ error: 'This room already has two active participants' });
  }

  if (!participant) {
    const participantId = requestedParticipantId || makeId();
    const role = Object.keys(room.participants).length === 0 ? 'caller' : 'callee';
    participant = {
      id: participantId,
      name,
      role,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };
    room.participants[participantId] = participant;
  } else {
    participant.name = name;
    participant.lastSeen = Date.now();
  }

  writeState();
  res.json({
    room: roomSummary(room),
    participant: {
      id: participant.id,
      name: participant.name,
      role: participant.role,
      joinedAt: participant.joinedAt,
      lastSeen: participant.lastSeen
    }
  });
});

app.get('/api/rooms/:roomId/state', (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const participantId = normalizeText(req.query.participantId);
  const room = state.rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (!participantId || !room.participants[participantId]) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  const participant = room.participants[participantId];
  participant.lastSeen = Date.now();
  pruneRoom(room);
  writeState();

  const signals = (room.signals || []).filter((signal) => signal.targetParticipantId === participantId);

  res.json({
    room: roomSummary(room),
    participant: {
      id: participant.id,
      name: participant.name,
      role: participant.role,
      joinedAt: participant.joinedAt,
      lastSeen: participant.lastSeen
    },
    signals
  });
});

app.post('/api/rooms/:roomId/heartbeat', (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const participantId = normalizeText(req.body.participantId);
  const room = state.rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const participant = room.participants[participantId];
  if (!participant) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  participant.lastSeen = Date.now();
  writeState();
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/signals', (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const fromParticipantId = normalizeText(req.body.fromParticipantId);
  const toParticipantId = normalizeText(req.body.toParticipantId);
  const type = normalizeText(req.body.type);
  const payload = req.body.payload || {};
  const room = state.rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (!room.participants[fromParticipantId] || !room.participants[toParticipantId]) {
    return res.status(404).json({ error: 'Participant not found' });
  }
  if (!type) {
    return res.status(400).json({ error: 'Signal type is required' });
  }

  const signal = {
    id: makeId(),
    roomId,
    fromParticipantId,
    toParticipantId,
    type,
    payload,
    createdAt: Date.now()
  };

  room.signals.push(signal);
  writeState();
  res.status(201).json({ signal });
});

app.post('/api/rooms/:roomId/leave', (req, res) => {
  const roomId = normalizeRoomId(req.params.roomId);
  const participantId = normalizeText(req.body.participantId);
  const room = state.rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (!room.participants[participantId]) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  delete room.participants[participantId];
  room.signals = (room.signals || []).filter(
    (signal) => signal.fromParticipantId !== participantId && signal.toParticipantId !== participantId
  );

  if (Object.keys(room.participants).length === 0) {
    room.createdAt = room.createdAt || Date.now();
  }

  writeState();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Video call site running on http://localhost:${PORT}`);
});
