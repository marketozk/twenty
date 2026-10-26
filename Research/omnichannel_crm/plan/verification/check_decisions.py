"""Executable plan examples only; no production code, database or network."""

import itertools
import json


# Independent hand-authored decision rows, not extracted from production code.
PUBLISH_EXPECTED = {
    (False, False, False): (None, True),
    (False, True, False): (None, False),
    (True, False, False): (None, False),
    (True, True, False): (None, False),
    (True, False, True): ('core-v1', False),
    (True, True, True): ('core-v1', False),
}
SEND_EXPECTED = {
    ('human', 'human'): True, ('human', 'assist'): True,
    ('human', 'auto'): False,
    ('ai', 'human'): False, ('ai', 'assist'): False, ('ai', 'auto'): True,
    ('workflow', 'human'): False, ('workflow', 'assist'): False,
    ('workflow', 'auto'): True,
    ('template', 'human'): True, ('template', 'assist'): True,
    ('template', 'auto'): True,
}
# Human dispatch after admission: auto composer must first take over to human.
ACTIVE_HUMAN_EXPECTED = {
    'pending': True, 'dispatching': True, 'accepted': True,
    'outcome_unknown': True, 'sent': False, 'failed': False, 'cancelled': False,
}
OBSERVATIONS = ('ack', 'timeout', 'sent_proof', 'reject_proof',
                'cancel_request', 'cancel_proof')
LIFECYCLE_EXPECTED = {
    'dispatching': ('accepted', 'outcome_unknown', 'sent', 'failed',
                    'dispatching', 'cancelled'),
    'accepted': ('accepted', 'outcome_unknown', 'sent', 'failed',
                 'accepted', 'cancelled'),
    'outcome_unknown': ('accepted', 'outcome_unknown', 'sent', 'failed',
                        'outcome_unknown', 'cancelled'),
}
# Guards are an executable specification, not an independent runtime oracle.
# The semantic mutations below demonstrate each claimed guard is observable.

def publish(captured, current, target, mutant):
    native = not current and not target
    if mutant != 'drop_captured_catalog':
        native = native and not captured
    version = ('core-v2' if mutant == 'replace_pinned_version' else 'core-v1')
    return version if target else None, native


def snapshot_dispatch(candidate, reference, required, captured_epoch,
                      current_epoch, mutant):
    if required and not reference and mutant != 'missing_reference_fallback':
        return 'gap'
    aliases = {'legacy-w': 'core-w', 'core-w': 'core-w', 'ordinary-w': 'ordinary-w'}
    canonical = candidate if mutant == 'compare_legacy_id' else aliases.get(candidate)
    if canonical is None:
        return 'gap'
    if canonical != 'core-w':
        return 'native'
    if captured_epoch != current_epoch and mutant != 'ignore_cancellation_epoch':
        return 'cancelled'
    return 'core-v1'


def dispatch(sender, mode, closed, rights, route, epoch, scope, template, lineage, mutant):
    if closed and mutant != 'ignore_closed':
        return False
    if not rights and mutant != 'ignore_rights':
        return False
    if not route and mutant != 'ignore_route':
        return False
    if sender == 'human':
        if mutant == 'human_requires_captured_scope' and not scope:
            return False
        if mutant == 'human_uses_automation_epoch' and not epoch:
            return False
        return mode != 'auto'
    if not scope and mutant != 'ignore_scope_edges':
        return False
    if not lineage and mutant != 'ignore_dispatch_cancellation':
        return False
    if not epoch and mutant != 'ignore_automation_epoch':
        return False
    if sender == 'template':
        return template or mutant == 'ignore_g17'
    if sender == 'ai' and mode == 'assist' and mutant == 'ai_sends_in_assist':
        return True
    return mode == 'auto'


def transition(state, observation, mutant):
    if state in ('sent', 'failed', 'cancelled'):
        contradictory = (observation == 'sent_proof' and state != 'sent'
                         or observation == 'reject_proof' and state != 'failed'
                         or observation == 'cancel_proof' and state != 'cancelled'
                         or observation == 'ack' and state in ('failed', 'cancelled'))
        action = 'reconcile' if contradictory else 'none'
        if mutant == 'ack_after_terminal_silent' and observation == 'ack':
            action = 'none'
        if mutant == 'silent_conflicting_proof':
            action = 'none'
        if mutant == 'late_timeout_regresses_sent' and state == 'sent' and observation == 'timeout':
            return 'outcome_unknown', action
        return state, action
    if state == 'pending':
        if observation == 'cancel_request':
            return ('pending', 'cancel_requested') if mutant == 'pending_cannot_cancel' else ('cancelled', 'none')
        if observation == 'dispatch':
            return 'dispatching', 'enqueue_same_id'
        return state, 'reconcile'
    if observation == 'cancel_request':
        return ('cancelled', 'none') if mutant == 'request_equals_cancel' else (state, 'cancel_requested')
    if observation == 'timeout':
        return ('pending', 'enqueue_same_id') if mutant == 'timeout_resends' else ('outcome_unknown', 'status_only')
    return {'ack': ('accepted', 'none'), 'sent_proof': ('sent', 'none'),
            'reject_proof': ('failed', 'none'), 'cancel_proof': ('cancelled', 'none')}[observation]


def can_set_auto(commands, mutant):
    for state, cancel_requested in commands:
        if state in ('sent', 'failed', 'cancelled'):
            continue
        if mutant == 'accepted_not_outstanding' and state == 'accepted':
            continue
        if mutant == 'cancel_request_unblocks_auto' and cancel_requested:
            continue
        return False
    return True


def check(mutant=None):
    failures = []
    counts = {'publish': 0, 'identity_reference_cancel': 0, 'dispatch': 0,
              'human_mode_gate': 0, 'lifecycle': 0}
    def equal(group, case, actual, expected):
        counts[group] += 1
        if actual != expected:
            failures.append({'group': group, 'case': case, 'actual': actual, 'expected': expected})

    for case, expected in PUBLISH_EXPECTED.items():
        equal('publish', case, publish(*case, mutant), expected)
    # Both external ID aliases must hit the same retained workflow identity.
    identity_cases = [
        (('legacy-w', True, True, 7, 7), 'core-v1'),
        (('core-w', True, True, 7, 7), 'core-v1'),
        (('missing-w', True, True, 7, 7), 'gap'),
        (('ordinary-w', True, True, 7, 7), 'native'),
        (('core-w', False, True, 7, 7), 'gap'),
        (('legacy-w', True, True, 7, 8), 'cancelled'),
        (('core-w', True, True, 7, 8), 'cancelled'),
    ]
    for case, expected in identity_cases:
        equal('identity_reference_cancel', case, snapshot_dispatch(*case, mutant), expected)
    for (sender, mode), mode_allowed in SEND_EXPECTED.items():
        for closed, rights, route, epoch, scope, template, lineage in itertools.product((False, True), repeat=7):
            expected = mode_allowed
            if (closed or not rights or not route
                    or (sender != 'human' and (not epoch or not scope or not lineage))
                    or (sender == 'template' and not template)):
                expected = False
            case = (sender, mode, closed, rights, route, epoch, scope, template, lineage)
            equal('dispatch', case, dispatch(*case, mutant), expected)
    command_options = list(itertools.product(ACTIVE_HUMAN_EXPECTED, (False, True)))
    for size in (0, 1, 2):
        for commands in itertools.combinations_with_replacement(command_options, size):
            expected = not any(ACTIVE_HUMAN_EXPECTED[state] for state, _ in commands)
            equal('human_mode_gate', commands, can_set_auto(commands, mutant), expected)
    for state, outcomes in LIFECYCLE_EXPECTED.items():
        for observation, expected in zip(OBSERVATIONS, outcomes, strict=True):
            action = {'cancel_request': 'cancel_requested', 'timeout': 'status_only'}.get(observation, 'none')
            equal('lifecycle', (state, observation), transition(state, observation, mutant), (expected, action))
    pending_expected = {'cancel_request': ('cancelled', 'none'), 'dispatch': ('dispatching', 'enqueue_same_id'),
                        'sent_proof': ('pending', 'reconcile'), 'ack': ('pending', 'reconcile'),
                        'timeout': ('pending', 'reconcile'), 'reject_proof': ('pending', 'reconcile'),
                        'cancel_proof': ('pending', 'reconcile')}
    for observation, expected in pending_expected.items():
        equal('lifecycle', ('pending', observation), transition('pending', observation, mutant), expected)
    for terminal in ('sent', 'failed', 'cancelled'):
        for observation in OBSERVATIONS:
            conflicts = {'sent': {'reject_proof', 'cancel_proof'},
                         'failed': {'sent_proof', 'cancel_proof', 'ack'},
                         'cancelled': {'sent_proof', 'reject_proof', 'ack'}}
            expected = (terminal, 'reconcile' if observation in conflicts[terminal] else 'none')
            equal('lifecycle', (terminal, observation), transition(terminal, observation, mutant), expected)
    return counts, failures


def main():
    counts, failures = check()
    if failures:
        raise AssertionError(failures)
    mutations = {}
    for mutant in ('drop_captured_catalog', 'replace_pinned_version', 'compare_legacy_id',
                   'missing_reference_fallback', 'ignore_cancellation_epoch', 'ignore_scope_edges',
                   'ignore_automation_epoch', 'ignore_closed', 'ignore_rights', 'ignore_route',
                   'human_uses_automation_epoch', 'ignore_g17', 'ai_sends_in_assist',
                   'accepted_not_outstanding', 'cancel_request_unblocks_auto',
                   'late_timeout_regresses_sent', 'request_equals_cancel', 'timeout_resends',
                   'pending_cannot_cancel', 'silent_conflicting_proof', 'ack_after_terminal_silent',
                   'ignore_dispatch_cancellation', 'human_requires_captured_scope'):
        _, caught = check(mutant)
        if not caught:
            raise AssertionError(f'Uncaught negative control: {mutant}')
        mutations[mutant] = {'caught': len(caught), 'witness': caught[0]}
    print(json.dumps({'scope': 'abstract plan only', 'cases': counts, 'total': sum(counts.values()),
                      'failures': 0, 'negative_controls': mutations, 'runtime_tests': False}, indent=2))


if __name__ == '__main__':
    main()
