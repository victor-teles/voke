import { schedule } from "@vokejs/aws";

export const nightlyCleanup = schedule({
  expression: "cron(0 3 * * ? *)",
  handler: (event) => {
    console.info("cleanup", event.scheduledTime);
  },
  timezone: "America/Sao_Paulo",
});
