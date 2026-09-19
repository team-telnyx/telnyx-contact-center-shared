import React from 'react';
const sections = { campaigns:'campaigns', 'contact-lists':'contact_lists', dnc:'dnc_lists', filters:'dialer_filters', 'time-sets':'dialer_time_sets', 'attempt-controls':'dialer_attempt_controls', 'disposition-codes':'disposition_codes', settings:'dialer_settings' };
const params = new URLSearchParams(window.location.search);
const section = params.get('section') || 'contact-lists';
const resource = sections[section];
const action = params.get('action') || 'read';
const permissions = [`${resource}:read`, `${resource}:${action}`];
const auth = { isAuth:true, loaded:true, permissions, can: key => (Array.isArray(key) ? key : [key]).some(value => permissions.includes(value)), canScreen: id => id === `supervisor.outbound-dialer.${section}` };
export function useAuth(){return auth;}
export function Can({ permission, screen, children, fallback = null }) {return (screen ? auth.canScreen(screen) : auth.can(permission)) ? children : fallback;}
