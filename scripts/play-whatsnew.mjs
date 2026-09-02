#!/usr/bin/env node
/**
 * Turns the GitHub release's hand-written notes into Google Play "What's new"
 * text: strips the auto-generated sections (changelog/downloads/footer) and
 * markdown, then trims to Play's 500-character limit.
 *
 * Reads RELEASE_NAME and RELEASE_BODY from the environment, writes
 * play-whatsnew/whatsnew-en-US.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { stripAutoSections } from './update-release-notes.mjs';

const LIMIT = 500;

function toPlainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let text = toPlainText(stripAutoSections(process.env.RELEASE_BODY || ''));
if (!text) text = process.env.RELEASE_NAME || 'Bug fixes and improvements.';
if (text.length > LIMIT) text = `${text.slice(0, LIMIT - 3).trimEnd()}...`;

mkdirSync('play-whatsnew', { recursive: true });
writeFileSync('play-whatsnew/whatsnew-en-US', text, 'utf8');
console.log(`Play "What's new" (${text.length} chars):\n${text}`);
