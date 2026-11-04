#!/usr/bin/env node
// Writes the owner's review copy of the Food Safety rules, in plain language.
//
//   node scripts/food-safety-review.mjs [output path]

import { writeFileSync } from 'node:fs';
import { FOOD_SAFETY_TOPICS } from '../src/data/foodSafetyRules.js';

const DEFAULT_OUTPUT = '/Users/andrewshih/Documents/Claude/Projects/DD Mau Training/Food-Safety-Rules-For-Review.md';
const output = process.argv[2] || DEFAULT_OUTPUT;

const allRules = FOOD_SAFETY_TOPICS.flatMap((topic) => topic.rules.map((rule) => ({ topic, rule })));
const flagged = allRules.filter(({ rule }) => rule.checkFirst);

const lines = [];

lines.push('# Food Safety rules, for your review');
lines.push('');
lines.push(`This is every rule in the new Food Safety tab: ${FOOD_SAFETY_TOPICS.length} topics and ${allRules.length} rules, in English and Spanish.`);
lines.push('');
lines.push('Each rule shows what staff will read. "On the exam" appears only where the manager exam wants a different answer from what we do in the store.');
lines.push('');
lines.push(`**${flagged.length} rules need you to check them first.** They're listed right below. Staff never see these notes.`);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## Check these first');
lines.push('');
lines.push('These rules are unconfirmed, are the report\'s own reading of the code, are a store choice, or are a question for the county.');

for (const topic of FOOD_SAFETY_TOPICS) {
    const rules = topic.rules.filter((rule) => rule.checkFirst);
    if (!rules.length) continue;
    lines.push('');
    lines.push(`### ${topic.icon} ${topic.titleEn}`);
    for (const rule of rules) {
        lines.push('');
        lines.push(`**${rule.titleEn}.** ${rule.en}`);
        lines.push('');
        lines.push(`> **Check first:** ${rule.checkFirst}`);
    }
}

lines.push('');
lines.push('---');
lines.push('');
lines.push('## All rules by topic');

for (const topic of FOOD_SAFETY_TOPICS) {
    lines.push('');
    lines.push(`### ${topic.icon} ${topic.titleEn} / ${topic.titleEs}`);
    for (const rule of topic.rules) {
        lines.push('');
        lines.push(`#### ${rule.titleEn} / ${rule.titleEs}`);
        lines.push('');
        lines.push(`- **English:** ${rule.en}`);
        lines.push(`- **Spanish:** ${rule.es}`);
        if (rule.examEn) {
            lines.push(`- **Exam note:** ${rule.examEn}`);
            lines.push(`- **Exam note, Spanish:** ${rule.examEs}`);
        }
        lines.push(`- **Source:** ${rule.source}`);
        if (rule.checkFirst) lines.push(`- ⚠️ **CHECK FIRST:** ${rule.checkFirst}`);
    }
}

lines.push('');
writeFileSync(output, lines.join('\n'));
console.log(`Wrote ${output}: ${FOOD_SAFETY_TOPICS.length} topics, ${allRules.length} rules, ${flagged.length} to check first.`);
