-- AGE-1667: milestone for a server guest that became an ordinary account in place.
-- Additive only: one enum value, no table or row change. It applies after
-- 20261124090000_add_funnel_events, which creates the FunnelEventType enum.
ALTER TYPE "FunnelEventType" ADD VALUE IF NOT EXISTS 'GUEST_REGISTERED';
