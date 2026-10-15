// Set BACKEND_ORIGIN to the HTTPS origin of the separately hosted API.
const backendOrigin = process.env.BACKEND_ORIGIN;
if (!backendOrigin) {
  throw new Error("Set BACKEND_ORIGIN to the public HTTPS backend origin.");
}
const backend = new URL(backendOrigin);
if (
  backend.protocol !== "https:" ||
  backend.pathname !== "/" ||
  backend.search ||
  backend.hash
) {
  throw new Error(
    "BACKEND_ORIGIN must be an HTTPS origin, such as https://api.example.com",
  );
}

export const config = {
  framework: "vite",
  buildCommand: "npm run build",
  outputDirectory: "dist",
  rewrites: [
    { source: "/api/:path*", destination: `${backend.origin}/api/:path*` },
    { source: "/(.*)", destination: "/index.html" },
  ],
};
