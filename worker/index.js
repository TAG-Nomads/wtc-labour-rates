import { handleStaffAuth } from "./routes/staff.js";
import { handleAwards } from "./routes/awards.js";
import { handleQuotes } from "./routes/quotes.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (
      pathname.startsWith("/api/staff/login") ||
      pathname.startsWith("/api/staff/logout") ||
      pathname.startsWith("/api/staff/me") ||
      pathname.startsWith("/api/staff/password") ||
      pathname.startsWith("/api/staff/accounts") ||
      pathname.startsWith("/api/staff/accept-invite") ||
      pathname.startsWith("/api/staff/settings")
    ) {
      return handleStaffAuth(request, env, url);
    }

    if (pathname.startsWith("/api/staff/awards") || pathname.startsWith("/api/staff/rates")) {
      return handleAwards(request, env, url);
    }

    if (pathname.startsWith("/api/staff/quotes") || pathname.startsWith("/api/staff/roster")) {
      return handleQuotes(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};
