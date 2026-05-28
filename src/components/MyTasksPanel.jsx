// MyTasksPanel — the "My Tasks" tab.
//
// History (load-bearing — explains why this file is so small):
//
//   2026-05-27  v1: monolithic personal task list (Apple-Reminders
//                   style circular checks).
//   2026-05-27  v2: Andrew asked for a manager kanban on this tab;
//                   I added role-based routing — admin/manager →
//                   kanban, staff → personal list. Hooks below an
//                   early return tripped the Rules of Hooks.
//   2026-05-28  v3: Rules-of-hooks fix — split into router +
//                   PersonalTaskList sub-component. Still using the
//                   isAdmin || isManager gate.
//   2026-05-28  v4: Andrew said operations access is admin +
//                   managers + shift leads — added shift-lead.
//   2026-05-28  v5: He still couldn't see the kanban. Live data
//                   confirmed his record is id 40 (in ADMIN_IDS),
//                   role "Manager", shiftLead:true — so the role
//                   check should have returned true. Two latent
//                   bugs accumulated along the way:
//                     • the shift-lead check was reading
//                       `currentStaff.isShiftLead`, but the
//                       canonical field is `shiftLead` (no `is`
//                       prefix) — Schedule + AdminPanel both use
//                       `shiftLead`, and chatPermissions.js's
//                       `isShiftLead` was a *prop* on a transformed
//                       viewer object, not the source field
//                     • the staffList async load opened a brief
//                       first-paint window where role flags were
//                       false, and once React committed the
//                       personal-list view it never re-routed
//
// Final form: stop routing. MyTasksPanel always renders the kanban.
// Edit-state controls inside AssignTasksPanel (+ Add, assign picker,
// delete trash, unassign X) are gated by `canModify` (admin /
// manager / shiftLead). Regular staff see the same kanban in
// read-only mode and can still mark their own assigned tasks done
// via the circular check button on each column row.
//
// Access list mirrors the Operations page per Andrew's correction:
// "no the operations page is not just admin its managers shift
// leads and admin."

import { lazy, Suspense } from 'react';

const AssignTasksPanel = lazy(() => import('./AssignTasksPanel'));

export default function MyTasksPanel({
    language = 'en',
    staffName = '',
    staffList = [],
    isAdmin = false,
    isManager = false,
}) {
    // shiftLead is the canonical field on staff records (Schedule +
    // AdminPanel both use this name). chatPermissions.js's
    // `isShiftLead` is a prop name on a transformed viewer object,
    // not a Firestore field — checking that here was a bug for ~24h
    // that silently kicked Andrew (and every other shift lead) into
    // the wrong view.
    const currentStaff = (staffList || []).find((s) => s.name === staffName) || null;
    const isShiftLead = !!(currentStaff?.shiftLead || currentStaff?.isShiftLead);

    return (
        <Suspense fallback={
            <div className="max-w-2xl mx-auto p-4">
                <div className="glass-skeleton h-20 w-full rounded-glass-lg" />
            </div>
        }>
            <AssignTasksPanel
                language={language}
                staffName={staffName}
                staffList={staffList}
                isAdmin={isAdmin}
                isManager={isManager}
                isShiftLead={isShiftLead}
            />
        </Suspense>
    );
}
