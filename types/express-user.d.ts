// attachUser() in lib/auth.js sets req.user on every request, so Express's own
// Request type needs to know about it. This is the one .d.ts in the project;
// everything else is annotated with JSDoc in the .js files themselves. See
// docs/typing.md.
declare namespace Express {
  interface Request {
    /** The signed-in instructor, or null when nobody is signed in. */
    user: {
      eppn: string;
      display_name: string | null;
      role: string;
      first_seen: number;
      last_seen: number;
    } | null;
  }
}
