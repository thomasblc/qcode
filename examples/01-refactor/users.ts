// Fetches user data then loads their orders.
// TODO: migrate to async/await.

export function loadUserWithOrders(userId: string) {
  return fetch(`/api/users/${userId}`)
    .then((res) => res.json())
    .then((user) => {
      return fetch(`/api/orders?userId=${userId}`)
        .then((res) => res.json())
        .then((orders) => {
          return { ...user, orders };
        });
    })
    .catch((err) => {
      console.error("failed to load user", err);
      throw err;
    });
}
