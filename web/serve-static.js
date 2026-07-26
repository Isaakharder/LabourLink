// Serves the Vite build output in production. Reads PORT directly from
// process.env rather than relying on shell variable expansion in the start
// command, which behaves inconsistently across platforms/shells.
import { createServer } from "http";
import handler from "serve-handler";

const port = process.env.PORT || 4173;

const server = createServer((request, response) =>
  handler(request, response, {
    public: "dist",
    rewrites: [{ source: "**", destination: "/index.html" }],
  })
);

server.listen(port, () => {
  console.log(`LabourLink web listening on port ${port}`);
});
