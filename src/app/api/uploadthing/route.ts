import { createRouteHandler } from 'uploadthing/next';
import { ourFileRouter } from './core';

const handlers = createRouteHandler({
  router: ourFileRouter,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
