// Entry point: node src/index.mjs. PORT defaults to 8080, the port the Durable Object forwards to.
import { createApp } from "./server.mjs";

const port = Number(process.env.PORT ?? 8080);
const { server, stats } = await createApp();
server.listen(port, "0.0.0.0", () => console.log(`pdf-service listening on ${port}`));

// A rollout sends SIGTERM and allows up to 15 minutes. Stop accepting, let running compiles finish, then exit.
const drain = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setInterval(() => { if (stats.active === 0 && stats.waiting === 0) process.exit(0); }, 200).unref();
};
process.on("SIGTERM", drain);
process.on("SIGINT", drain);
