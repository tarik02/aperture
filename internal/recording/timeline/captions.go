package timeline

// mapToolCaptions places the captions of page-changing tools on the segments
// that were recording while the tool ran, cut to each. Such a tool does not know
// which target it acted on, so a caption goes to every segment it overlaps, the
// way input sent through the debugging protocol does. One that spans two
// segments appears once in each, and the two halves meet without a gap.
func (b *Builder) mapToolCaptions(segments []*placed) []Caption {
	var captions []Caption
	for _, input := range b.captions {
		end := input.End
		if end.Before(input.Start) {
			end = input.Start
		}
		for _, segment := range segments {
			if end.Before(segment.ownStart) || input.Start.After(segment.ownEnd) {
				continue
			}
			start := maxTime(input.Start, segment.ownStart)
			stop := minTime(end, segment.ownEnd)
			if stop.Before(start) {
				stop = start
			}
			captions = append(captions, Caption{
				StartMs: toMs(segment.video(start)),
				EndMs:   toMs(segment.video(stop)),
				Text:    input.Text,
				Tool:    input.Tool,
			})
		}
	}
	return captions
}
