'use strict';

const path = require('node:path');

// Gateway code lives under apps/, while existing user data and credentials stay
// at the repository root until a separate, verified state migration is approved.
const REPO_ROOT = path.resolve(__dirname, '../../..');
const GATEWAY_STATE_DIR = path.join(REPO_ROOT, 'gateway');
const BRAIN_STATE_DIR = path.join(REPO_ROOT, 'brain');

module.exports = { REPO_ROOT, GATEWAY_STATE_DIR, BRAIN_STATE_DIR };
