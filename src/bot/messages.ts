// Every user-facing string, in Russian with polite "вы". Handlers pick a message here and never
// build copy themselves.
export const messages = {
  welcome: 'Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу.',
  genericError: 'Что-то пошло не так. Попробуйте ещё раз.',
} as const;
