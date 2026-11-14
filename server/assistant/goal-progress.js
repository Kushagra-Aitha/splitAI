import { listGoals } from '../goals/read.js';
import { today } from '../capital-two/input.js';
const money = (cents) => `$${(BigInt(cents) / 100n).toLocaleString('en-US')}.${String(BigInt(cents) % 100n).padStart(2, '0')}`;
const ceil = (n, d) => Number((n + d - 1n) / d);
export function progressForGoal(goal, now = new Date()) {
  const date = today(now), remainingCents = Math.max(0, goal.targetCents - goal.savedCents);
  const elapsedDays = Math.max(1, Math.floor((Date.parse(date) - Date.parse(today(new Date(goal.createdAt)))) / 86400000));
  const daysLeft = goal.targetDate ? Math.ceil((Date.parse(goal.targetDate) - Date.parse(date)) / 86400000) : null;
  const saved = BigInt(goal.savedCents), elapsed = BigInt(elapsedDays);
  const paceCentsPerDay = Number(saved / elapsed);
  const requiredCentsPerDay = daysLeft !== null && daysLeft > 0 ? ceil(BigInt(remainingCents), BigInt(daysLeft)) : null;
  const status = !remainingCents ? 'funded' : daysLeft === null ? 'no_date' : daysLeft <= 0 ? 'short'
    : saved * BigInt(daysLeft) >= BigInt(remainingCents) * elapsed ? 'on_track' : 'short';
  return { id: goal.id, name: goal.name, savedCents: goal.savedCents, targetCents: goal.targetCents,
    remainingCents, targetDate: goal.targetDate, paceCentsPerDay, requiredCentsPerDay, status };
}
export async function answerGoalProgress(db, actorId, now = new Date()) {
  const { goals } = await listGoals(db, actorId);
  const progress = goals.map((goal) => progressForGoal(goal, now));
  const answer = progress.length ? progress.map((g) => `${g.name}: ${money(g.savedCents)} of ${money(g.targetCents)} set aside. ${
    ({ funded: 'Fully funded.', no_date: 'No target date is set.', on_track: 'On track at the observed net savings pace.', short: 'Short of the target at the observed net savings pace.' })[g.status]
  }${g.requiredCentsPerDay !== null && g.remainingCents ? ` Reaching the date requires about ${money(g.requiredCentsPerDay)} per day.` : ''}`).join(' ')
    : 'You have no savings goals yet. Create one in Goals to start setting money aside.';
  return { type: 'answer', intent: 'goal_progress', asOf: now.toISOString(), answer,
    goals: progress, paceNote: 'Pace is net savings since creation, including initial funding. It is an estimate, not a promised return or automatic contribution.' };
}
