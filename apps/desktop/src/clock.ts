// The app's one way of showing a time of day: the person's own clock (12- or
// 24-hour, as their computer is set), "7:06 PM" - never "07:06 PM" in one place
// and "7:06 PM" in another.
export const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
