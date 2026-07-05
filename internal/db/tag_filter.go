package db

// TagOperator controls list filtering against resource tags.
type TagOperator string

const (
	TagOperatorEqual    TagOperator = "eq"
	TagOperatorNotEqual TagOperator = "neq"
	TagOperatorIn       TagOperator = "in"
	TagOperatorNotIn    TagOperator = "not_in"
)

// TagFilter narrows list queries to resources that have a matching tag key.
type TagFilter struct {
	Key      string
	Operator TagOperator
	Values   []string
}
