#!/usr/bin/env node
import fs from 'node:fs';
import { compareInteractionSnapshots } from '../state-diff.mjs';

export function verifyInteractionReport(source, replica) {
  const steps = source.steps || [];
  const replicaSteps = replica.steps || [];
  const results = [];
  const count = Math.max(steps.length, replicaSteps.length);
  for (let index = 0; index < count; index++) {
    const left = steps[index];
    const right = replicaSteps[index];
    if (!left || !right) {
      results.push({ index, verified: false, reason: 'missing-step' });
      continue;
    }
    const compared = compareInteractionSnapshots(left.snapshot, right.snapshot);
    results.push({ index, action: left.action || null, ...compared });
  }
  const verified = results.filter(item => item.verified).length;
  return {
    verified,
    total: results.length,
    denominator: results.length,
    replicaVerified: results.length > 0 && verified === results.length,
    results
  };
}

if (process.argv[1] && process.argv[1].endsWith('verify-interactions.mjs')) {
  const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const replica = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const report = verifyInteractionReport(source, replica);
  console.log(JSON.stringify(report, null, 2));
  if (!report.replicaVerified) process.exitCode = 2;
}
