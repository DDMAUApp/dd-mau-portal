// Until the owner has read and signed off on the rules, the Food Safety tab shows
// only to admins, so nobody treats an unread number as correct. Flip this in the
// release that opens it to everyone, along with clearing `draft` on its modules.
export const FOOD_SAFETY_OPEN_TO_ALL = false;

export function canSeeFoodSafety(isAdminUser) {
    return FOOD_SAFETY_OPEN_TO_ALL || isAdminUser === true;
}
