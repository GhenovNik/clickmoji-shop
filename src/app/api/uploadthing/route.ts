import { createRouteHandler } from "uploadthing/next";
import { NextRequest } from "next/server";

import { ourFileRouter } from "./core";

const handlers = createRouteHandler({
  router: ourFileRouter,
});

export const GET = handlers.GET;

export async function POST(req: NextRequest) {
  try {
    console.log("UploadThing POST called");
    console.log("URL:", req.url);
    const result = await handlers.POST(req);
    console.log("UploadThing POST result");
    console.log("Response status:", result?.status);

    // Log response body if error
    if (result?.status && result.status >= 400) {
      const clonedResponse = result.clone();
      const body = await clonedResponse.text();
      console.error("UploadThing error response body:", body);
    }

    return result;
  } catch (error) {
    console.error("UploadThing POST error:", error);
    console.error("Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
    throw error;
  }
}
