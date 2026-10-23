import { api, updatePreferences, updateFeedback } from '../src/shared/api/client';

// Compile-only negative cases: relaxing the generated command contracts makes
// these directives fail as unused, exposing accidental type drift.
function checkCommands() {
  // @ts-expect-error A read route cannot become a POST through a handwritten client.
  void api.POST('/dashboard');
  // @ts-expect-error A renamed route must update its consumers.
  void api.GET('/dashbord');
  // @ts-expect-error A revision is an integer, never a string.
  void updatePreferences({ revision: '0', settings: { max_weekly_hours: 30, min_fixed_twd: 3000, categories: ['AI agent'] } });
  // @ts-expect-error Discovery feedback does not authorize a proposal.
  void updateFeedback('id', { versions: {}, feedback: 'approved' });
}
void checkCommands;
