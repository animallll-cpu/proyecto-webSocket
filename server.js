require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

const app = express();

const os = require('os');
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '192.168.x.x';
}

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run(`DROP TABLE IF EXISTS usuarios`);
  db.run(`DROP TABLE IF EXISTS mensajes`);
  
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE,
    email TEXT,
    nombre TEXT,
    avatar TEXT,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_nombre TEXT,
    mensaje TEXT,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

app.use(session({
  secret: 'proyecto-websocket-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: 'http://localhost:3000/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  db.get('SELECT * FROM usuarios WHERE google_id = ?', [profile.id], (err, user) => {
    if (user) return done(null, user);
    db.run(`INSERT INTO usuarios (google_id, email, nombre, avatar) VALUES (?, ?, ?, ?)`,
      [profile.id, profile.emails[0].value, profile.displayName, profile.photos[0].value],
      function(err) {
        db.get('SELECT * FROM usuarios WHERE id = ?', [this.lastID], (err, newUser) => done(null, newUser));
      });
  });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM usuarios WHERE id = ?', [id], (err, user) => done(err, user));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error(err);
    req.session.destroy((err) => {
      if (err) console.error(err);
      res.redirect('/');
    });
  });
});

app.get('/api/usuario', (req, res) => res.json(req.user || null));
app.use(express.static('public'));

let contadorAnonimos = 0;
let usuariosConectados = new Map(); // ws -> { id, nombre, esGoogle, avatar }

function broadcast(data, exclude = null) {
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastUsuariosConectados() {
  const listaUsuarios = Array.from(usuariosConectados.values()).map(u => ({
    nombre: u.nombre,
    esGoogle: u.esGoogle,
    avatar: u.avatar || null
  }));
  
  broadcast({
    type: 'usuarios_conectados',
    usuarios: listaUsuarios,
    total: listaUsuarios.length
  });
}

function obtenerHistorialReciente(callback) {
  callback([]);
}

function guardarMensaje(nombre, mensaje) {
  db.run('INSERT INTO mensajes (usuario_nombre, mensaje) VALUES (?, ?)', [nombre, mensaje]);
}

wss.on('connection', (ws, req) => {
  let asignado = false;
  
  function asignarNombreAnonimo() {
    if (asignado) return;
    asignado = true;
    
    contadorAnonimos++;
    const usuarioNombre = `Usuario_${contadorAnonimos}`;
    
    usuariosConectados.set(ws, { 
      id: null, 
      nombre: usuarioNombre, 
      esGoogle: false, 
      avatar: null 
    });
    
    ws.send(JSON.stringify({ type: 'asignacion', nombre: usuarioNombre, esGoogle: false }));
    
    ws.send(JSON.stringify({ type: 'historial', data: [] }));
    
    broadcast({ type: 'notification', msg: `✨ ${usuarioNombre} se ha unido al chat` });
    broadcastUsuariosConectados();
  }
  
  const cookies = req.headers.cookie;
  if (cookies && cookies.includes('connect.sid')) {
    db.get('SELECT * FROM usuarios WHERE google_id IS NOT NULL ORDER BY id DESC LIMIT 1', (err, user) => {
      if (user && !asignado) {
        asignado = true;
        
        usuariosConectados.set(ws, { 
          id: user.id, 
          nombre: user.nombre, 
          esGoogle: true, 
          avatar: user.avatar 
        });
        
        ws.send(JSON.stringify({ type: 'asignacion', nombre: user.nombre, esGoogle: true, avatar: user.avatar }));
        
        ws.send(JSON.stringify({ type: 'historial', data: [] }));
        
        broadcast({ type: 'notification', msg: `✨ ${user.nombre} se ha unido al chat` });
        broadcastUsuariosConectados();
      } else if (!asignado) {
        asignarNombreAnonimo();
      }
    });
  } else {
    asignarNombreAnonimo();
  }
  
  ws.on('message', (data) => {
    const info = usuariosConectados.get(ws);
    if (!info) return;
    
    const mensajeTexto = data.toString();
    if (!mensajeTexto.trim()) return;
    
    guardarMensaje(info.nombre, mensajeTexto);
    
    broadcast({
      type: 'message',
      user: info.nombre,
      msg: mensajeTexto,
      hora: new Date().toLocaleTimeString(),
      esGoogle: info.esGoogle,
      avatar: info.avatar
    });
  });
  
  ws.on('close', () => {
    const info = usuariosConectados.get(ws);
    if (info) {
      broadcast({ type: 'notification', msg: `👋 ${info.nombre} ha salido del chat` });
      usuariosConectados.delete(ws);
      broadcastUsuariosConectados();
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor corriendo en el puerto ${PORT}`);
  console.log(`📡 WebSocket activo`);
  console.log(`🌐 Acceso local: http://localhost:${PORT}`);
  console.log(`🌐 Acceso red local: http://${getLocalIP()}:${PORT}`);
  console.log(`👥 Usuarios anónimos comienzan desde Usuario_1`);
});