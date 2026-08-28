/* Activity probe: real in-flight work, so the widget can be checked against it.
 *
 * The activity lists claim to show what is running. Nothing on this machine
 * proved that, because every workflow on disk had already finished - and the
 * first version of the filter was wrong for exactly that reason: it matched
 * wf_*.json by status, and that file does not exist until the run ENDS.
 *
 * This workflow makes work that is unambiguously in flight for a known
 * duration, so `activity-probe-check.js` can watch the feed while it runs.
 *
 * Run it with the Workflow tool:
 *   Workflow({ scriptPath: '<repo>/usage-server/test/activity-probe.workflow.js',
 *              args: { agents: 3, seconds: 60 } })
 *
 * args.agents  how many subtasks to run at once (default 3)
 * args.seconds how long each one blocks       (default 60)
 */

export const meta = {
  name: 'activity-probe',
  description: 'Run N subtasks that each block for S seconds, so the usage widget can be watched against real in-flight work',
  phases: [{ title: 'Wait', detail: 'agents blocking in parallel' }],
}

const AGENTS = (args && args.agents) || 3
const SECONDS = (args && args.seconds) || 60

/* A bare `sleep` / `Start-Sleep` is refused by the harness, and an agent told
   to sleep will background it and return immediately - which is precisely the
   thing this probe must not do. A node one-liner is an ordinary foreground
   command that genuinely blocks, and printing its own elapsed time makes any
   shortcut visible in the result rather than silent. */
const WAIT = 'node -e "const t=Date.now();setTimeout(()=>console.log(\'waited \'+Math.round((Date.now()-t)/1000)+\'s\'),' + (SECONDS * 1000) + ')"'

phase('Wait')

log(`${AGENTS} subtask(s), ${SECONDS}s each - watch /usage or the widget's Activity view now`)

const results = await parallel(
  Array.from({ length: AGENTS }, (_, i) => () =>
    agent(
      /* First line first, and distinct per agent: the live subtask row is
         named from it. opts.label below names the row in /workflows, but it is
         never written to disk, so it cannot name anything in the widget. */
      `probe-wait-${i + 1}: block for ${SECONDS}s, report elapsed\n\n` +
      'Run exactly this one command in the foreground and nothing else:\n\n' + WAIT + '\n\n' +
      'Do NOT pass run_in_background. Do NOT use any other tool. Do not read files or explain. ' +
      'It takes about ' + SECONDS + ' seconds to return; that is expected, wait for it. ' +
      'Reply with only the command\'s stdout, e.g. "waited ' + SECONDS + 's".',
      { label: `probe-wait-${i + 1}`, phase: 'Wait', model: 'haiku', effort: 'low' }
    )
  )
)

return { agents: AGENTS, seconds: SECONDS, results }
