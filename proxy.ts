import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Precise: matches /app and /app/<anything>, but NOT /application, /appstore, etc.
const isProtected = createRouteMatcher(['/app', '/app/:path*'])

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
}
