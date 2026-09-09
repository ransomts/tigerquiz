require "test_helper"

class RosterTest < ActiveSupport::TestCase
  setup { @user = User.create!(eppn: "ada@example.edu") }

  test "a roster needs students and a safe slug" do
    refute @user.rosters.build(slug: "p3", title: "Period 3", students: []).valid?
    refute @user.rosters.build(slug: "bad id", title: "Period 3", students: [ { "name" => "Ada" } ]).valid?
    roster = @user.rosters.create!(slug: "p3", title: "Period 3", students: [ { "name" => "Ada", "id" => "1" }, { "name" => "Alan" } ])
    assert_equal({ "id" => "p3", "title" => "Period 3", "count" => 2 }, roster.summary)
    assert_equal [ { "name" => "Ada", "id" => "1" }, { "name" => "Alan", "id" => nil } ], roster.playable["students"]
  end
end
