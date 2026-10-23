"""Explicit readonly provider lookup and pre-rollback cancellation operations."""
import argparse
from .store import SQLiteStore
from .submission_runtime import SubmissionRuntime


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',required=True)
    sub=parser.add_subparsers(dest='action',required=True)
    lookup=sub.add_parser('verify-bid');lookup.add_argument('--config',required=True);lookup.add_argument('--intent',required=True)
    lookup.add_argument('--revision',type=int,required=True);lookup.add_argument('--bid',type=int,required=True)
    sub.add_parser('cancel-for-rollback')
    args=parser.parse_args(argv);store=SQLiteStore(args.database)
    try:
        if args.action=='verify-bid':
            result=SubmissionRuntime(store,args.config).verify_bid(args.intent,args.revision,args.bid)
            print('provider_verified_accepted; original transport status: '+result['status'])
        else:print('cancelled unattempted approvals: '+str(store.submissions.cancel_pending_for_rollback()))
    except Exception:
        parser.exit(1,'Operation unavailable; original submission evidence retained.\n')


if __name__=='__main__':main()
