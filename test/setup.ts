try {
  process.loadEnvFile(".env.local");
} catch {
  /* CI supplies the environment directly */
}

if (!process.env.DATABASE_APP_URL || !process.env.DATABASE_URL) {
  throw new Error(
    "Isolation tests need both connections: DATABASE_URL (owner, for fixtures) " +
      "and DATABASE_APP_URL (the restricted role the application uses). " +
      "Running them against one privileged connection would make them pass " +
      "without proving anything.",
  );
}
