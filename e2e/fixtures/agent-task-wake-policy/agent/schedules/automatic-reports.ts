import { defineSchedule } from "eve/schedules";
import reports from "../channels/scheduled-reports";

export default defineSchedule({
  cron: "0 9 * * *",
  taskDeliveryPolicy: "auto",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      to(reports, { id: crypto.randomUUID() }).send(
        "Alice asks Bob to prepare reports A and B for a joint comparison. Share the comparison once both reports are available.",
        { auth: appAuth },
      ),
    );
  },
});
