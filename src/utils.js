'use strict';

function nowIso() {
  return new Date().toISOString();
}

function isoPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Basic UUID v4-ish generator, no external dependency needed.
 */
function generateId(prefix = 'job') {
  const rand = () => Math.random().toString(16).slice(2);
  return `${prefix}_${Date.now().toString(36)}${rand()}${rand()}`.slice(0, 40);
}

module.exports = { nowIso, isoPlusSeconds, generateId };
