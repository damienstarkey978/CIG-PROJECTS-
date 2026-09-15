export const config = {
  port: Number(process.env.PORT ?? 8080),
  demoMode: process.env.DEMO_MODE === "true",
  dashboardPassword: process.env.DASHBOARD_PASSWORD || null,
  defaultSnipeSeconds: Number(process.env.DEFAULT_SNIPE_SECONDS ?? 8),
  hibidEmail: process.env.HIBID_EMAIL || null,
  hibidPassword: process.env.HIBID_PASSWORD || null,
};
