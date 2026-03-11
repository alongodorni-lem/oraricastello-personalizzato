#!/usr/bin/env node
/**
 * Server standalone per Newsletter Planyo SMS
 * Avvia: node server.js  →  http://localhost:3456
 * Per integrazione in app esistente: usa router.js
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const router = require('./router');

const app = express();
const PORT = process.env.PORT || 3456;

app.use('/', router);

app.listen(PORT, () => {
  console.log(`Newsletter SMS - Interfaccia web: http://localhost:${PORT}`);
});
