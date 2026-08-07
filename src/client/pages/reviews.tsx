import { useSuspenseQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { reviewsQuery } from '../lib/queries.ts';
import { ReviewsTable } from '../components/reviews-table.tsx';
import { EmptyState, Muted, PageTitle } from '../components/section.tsx';

export function ReviewsPage() {
	const { page } = useSearch({ from: '/reviews' });
	const { data } = useSuspenseQuery(reviewsQuery(page));

	return (
		<>
			<PageTitle aside={<Muted>{data.total} total</Muted>}>reviews</PageTitle>
			{data.reviews.length === 0 ? (
				<div className="mt-6">
					<EmptyState>
						No reviews yet — open a pull request on an enabled repository and it will show up here.
					</EmptyState>
				</div>
			) : (
				<div className="mt-4">
					<ReviewsTable reviews={data.reviews} />
				</div>
			)}
			{data.pages > 1 ? (
				<div className="mt-4 flex items-center justify-between text-[0.85rem]">
					<span>
						{data.page > 1 ? (
							<Link
								to="/reviews"
								search={{ page: data.page - 1 }}
								className="text-accent-bright hover:underline"
							>
								&larr; newer
							</Link>
						) : null}
					</span>
					<Muted>
						page {data.page} of {data.pages}
					</Muted>
					<span>
						{data.page < data.pages ? (
							<Link
								to="/reviews"
								search={{ page: data.page + 1 }}
								className="text-accent-bright hover:underline"
							>
								older &rarr;
							</Link>
						) : null}
					</span>
				</div>
			) : null}
		</>
	);
}
