import { defineSchedule } from "#public/schedules/index.js";

export const promptSchedule = defineSchedule({
  cron: "0 9 * * *",
  markdown: "Prepare the daily report.",
});

export default defineSchedule({
  cron: "0 9 * * *",
  run({ waitUntil, appAuth }) {
    waitUntil(Promise.resolve(appAuth.principalId));
  },
});
